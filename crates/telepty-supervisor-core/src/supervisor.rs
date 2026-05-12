//! Supervisor lifecycle.
//!
//! - M1 surface: [`spawn_observe`] — spawn + observe a child until natural exit.
//! - M2 surface: [`run`] — graceful/forced kill, manifest atomic write, A8
//!   finalize (unlink clean / tombstone abnormal).
//! - M3 additions: per-session UDS server (`ipc::serve`) feeding a single
//!   mpsc ingest queue (F5 / SPEC §7.G); supervisor consumes the queue and
//!   dispatches `inject` / `kill` / `delete` / `signal` / `ping`. PTY output
//!   is broadcast as `wire::Frame::output` to subscribed UDS clients AND
//!   written raw to stdout for M1/M2 smoke parity.
//!
//! Invariants (plan §3.1, codex F5, SPEC-C3-r1 §0.3 / §4.1.1 / §5.1 Order A):
//! - Caller drives a `tokio` current_thread runtime.
//! - All blocking syscalls (`Child::wait`, `Read::read`, `killpg`) go through
//!   `tokio::task::spawn_blocking`; the reactor never blocks.
//! - `pair.slave` dropped immediately after spawn (§5.4).
//! - POSIX: portable-pty's slave-spawn calls `setsid()` → `child.process_id() == pgid`.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task;
use tokio::time::Duration;

use crate::ipc::{self, frame_op_key, IdempotencyLru, Ingest, IPC_QUEUE_DEPTH, OUTPUT_BROADCAST_DEPTH};
use crate::kill_gate::{
    perform_kill, KillKind, KillOutcome, KillTimeouts, PTY_READ_DRAIN_DEADLINE_MS,
};
use crate::manifest::{
    self, now_rfc3339, ExitReason, IpcRef, KillGateConfig, Manifest, Status, SCHEMA_VERSION,
};
use crate::wire::{ErrorCode, ExitReasonWire, Frame, Kind};

#[derive(Debug)]
pub struct ObserveOutcome {
    pub exit_status: ExitStatus,
}
impl ObserveOutcome {
    pub fn exit_code(&self) -> i32 {
        if self.exit_status.success() { 0 } else { self.exit_status.exit_code() as i32 }
    }
}

/// M1 observe-only entry point — kept for tests and the simplest M1 smoke path.
pub async fn spawn_observe(argv: &[OsString], cwd: Option<PathBuf>) -> Result<ObserveOutcome> {
    let (head, rest) = argv.split_first().context("spawn_observe argv empty")?;
    let mut builder = CommandBuilder::new(head);
    builder.args(rest);
    if let Some(dir) = cwd { builder.cwd(dir); }
    let pair = native_pty_system().openpty(default_pty_size()).context("openpty")?;
    let mut child = pair.slave.spawn_command(builder).context("spawn_command")?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().context("try_clone_reader")?;
    let read_task = task::spawn_blocking(move || drain_pty_to_stdout(reader));
    drop(pair.master);
    let wait_task = task::spawn_blocking(move || child.wait().context("child wait"));
    let exit_status = wait_task.await.context("wait join")??;
    match read_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "pty read loop error"),
        Err(e) => tracing::warn!(error = %e, "pty read task join error"),
    }
    Ok(ObserveOutcome { exit_status })
}

#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub sid: String,
    pub cwd: Option<PathBuf>,
    pub argv: Vec<OsString>,
    pub kill_gate: KillGateConfig,
    pub kill_timeouts: KillTimeouts,
}

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_status: Option<ExitStatus>,
    pub exit_reason: ExitReason,
    pub exit_signal: Option<String>,
    pub escalated: bool,
}

impl RunOutcome {
    /// Normal: forward child code. Successful kill / unkillable: 0 per SPEC §1.3.7.
    pub fn exit_code(&self) -> i32 {
        match self.exit_reason {
            ExitReason::Normal => match &self.exit_status {
                Some(s) if s.success() => 0,
                Some(s) => s.exit_code() as i32,
                None => 1,
            },
            _ => 0,
        }
    }
}

/// M3 entry point: spawn + observe + IPC server + kill orchestration + A8 finalize.
pub async fn run(cfg: SupervisorConfig) -> Result<RunOutcome> {
    let (head, rest) = cfg.argv.split_first().context("supervisor argv empty")?;
    let mut builder = CommandBuilder::new(head);
    builder.args(rest);
    if let Some(dir) = &cfg.cwd { builder.cwd(dir); }

    let pair = native_pty_system().openpty(default_pty_size()).context("openpty")?;
    let mut child = pair.slave.spawn_command(builder).context("spawn_command")?;
    drop(pair.slave);
    let child_pid = child.process_id().context("portable-pty no child pid (POSIX-only)")?;
    let pgid: i32 = child_pid as i32;

    // Manifest atomic write — ERR_SPAWN_FAILED on collision per F11 / plan §6.1.
    let session_dir = manifest::session_dir(&cfg.sid)?;
    let manifest_path = manifest::manifest_path(&cfg.sid)?;
    let socket_path = ipc::socket_path_for(&session_dir);
    if let Ok(existing) = std::fs::read_to_string(&manifest_path) {
        if let Ok(m) = serde_json::from_str::<Manifest>(&existing) {
            if matches!(m.status, Status::Ready | Status::Draining | Status::Spawning) {
                let _ = child.kill();
                anyhow::bail!("ERR_SPAWN_FAILED: live manifest already at {}", manifest_path.display());
            }
        }
    }
    let live_manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        id: cfg.sid.clone(),
        pid: std::process::id(),
        ipc: IpcRef { kind: "uds".into(), path: socket_path.to_string_lossy().into_owned() },
        status: Status::Ready,
        restart_count: 0,
        created_at: now_rfc3339(),
        kill_gate: cfg.kill_gate.clone(),
        exit_reason: None,
        exit_signal: None,
        exit_code: None,
        crashed_at: None,
        unkillable_at: None,
        stopped_at: None,
    };
    manifest::write_atomic(&manifest_path, &live_manifest)?;
    tracing::info!(sid = %cfg.sid, pid = live_manifest.pid, child_pid, sock = %socket_path.display(), "supervisor ready");

    // IPC plumbing.
    let listener = ipc::bind_socket(&socket_path)?;
    let (ingest_tx, mut ingest_rx) = mpsc::channel::<Ingest>(IPC_QUEUE_DEPTH);
    let (output_tx, _output_rx0) = broadcast::channel::<Frame>(OUTPUT_BROADCAST_DEPTH);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ipc_task = tokio::spawn(ipc::serve(listener, ingest_tx.clone(), output_tx.clone(), shutdown_rx));

    // PTY reader: broadcast as Frame::output + mirror to stdout for M1/M2 smoke parity.
    let reader = pair.master.try_clone_reader().context("try_clone_reader")?;
    let writer = pair.master.take_writer().context("take_writer")?;
    let sid_for_reader = cfg.sid.clone();
    let output_tx_reader = output_tx.clone();
    let read_task = task::spawn_blocking(move || drain_pty_dual(reader, output_tx_reader, sid_for_reader));
    drop(pair.master);

    let (wait_tx, mut wait_rx) = oneshot::channel::<std::io::Result<ExitStatus>>();
    let wait_join = task::spawn_blocking(move || {
        let r = child.wait();
        let _ = wait_tx.send(r);
    });

    let mut sigterm = signal(SignalKind::terminate()).context("install SIGTERM")?;
    let mut sigint = signal(SignalKind::interrupt()).context("install SIGINT")?;

    let mut lru = IdempotencyLru::new();
    let pty_writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

    // Consumer loop — single linearization point per F5 / SPEC §7.G.
    let outcome: KillOutcome = loop {
        tokio::select! {
            biased;
            r = &mut wait_rx => match r {
                Ok(Ok(status)) => break KillOutcome::Reaped {
                    exit_status: status, exit_reason: ExitReason::Normal,
                    exit_signal: "", escalated: false,
                },
                Ok(Err(e)) => return Err(e.into()),
                Err(_) => return Err(anyhow::anyhow!("child wait closed")),
            },
            _ = sigterm.recv() => {
                tracing::info!("SIGTERM → graceful kill");
                break perform_kill(pgid, &mut wait_rx, KillKind::Graceful, cfg.kill_timeouts).await?;
            }
            _ = sigint.recv() => {
                tracing::info!("SIGINT → graceful kill");
                break perform_kill(pgid, &mut wait_rx, KillKind::Graceful, cfg.kill_timeouts).await?;
            }
            ingest = ingest_rx.recv() => {
                let Some(Ingest { frame, .. }) = ingest else { continue };
                if let Some(triggered) = dispatch_ingest(frame, &cfg.sid, &output_tx, &pty_writer, &mut lru).await {
                    tracing::info!(?triggered, "ingest triggered terminal kill");
                    break perform_kill(pgid, &mut wait_rx, triggered, cfg.kill_timeouts).await?;
                }
            }
        }
    };
    let _ = wait_join.await;
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_millis(200), ipc_task).await;
    let _ = tokio::time::timeout(
        Duration::from_millis(PTY_READ_DRAIN_DEADLINE_MS),
        read_task,
    ).await;
    ipc::unlink_socket(&socket_path);

    let (exit_status, exit_reason, exit_signal, escalated) = match outcome {
        KillOutcome::Reaped { exit_status, exit_reason, exit_signal, escalated } => (
            Some(exit_status), exit_reason,
            if exit_signal.is_empty() { None } else { Some(exit_signal.to_string()) },
            escalated,
        ),
        KillOutcome::Unkillable { last_signal } => (
            None, ExitReason::Unkillable, Some(last_signal.to_string()), true,
        ),
    };

    let wire_reason = to_wire_reason(exit_reason);
    let drain_frame = Frame::shutdown_drain(
        &cfg.sid, wire_reason,
        exit_status.as_ref().map(|s| s.exit_code() as i32), escalated,
    );
    let _ = output_tx.send(drain_frame);

    if exit_reason.is_clean() {
        manifest::unlink_clean(&manifest_path)?;
    } else {
        let now = now_rfc3339();
        let mut tomb = live_manifest;
        tomb.status = Status::Error;
        tomb.exit_reason = Some(exit_reason);
        tomb.exit_signal = exit_signal.clone();
        tomb.exit_code = exit_status.as_ref().map(|s| s.exit_code() as i32);
        tomb.stopped_at = Some(now.clone());
        match exit_reason {
            ExitReason::Unkillable => tomb.unkillable_at = Some(now),
            ExitReason::Crashed => tomb.crashed_at = Some(now),
            _ => {}
        }
        manifest::write_tombstone(&manifest_path, &tomb)?;
    }
    tracing::info!(?exit_reason, ?exit_signal, escalated, "supervisor finalized");

    Ok(RunOutcome { exit_status, exit_reason, exit_signal, escalated })
}

/// Returns `Some(kind)` when the dispatched frame triggers terminal kill flow.
async fn dispatch_ingest(
    frame: Frame,
    sid: &str,
    output_tx: &broadcast::Sender<Frame>,
    pty_writer: &std::sync::Arc<tokio::sync::Mutex<Box<dyn Write + Send>>>,
    lru: &mut IdempotencyLru,
) -> Option<KillKind> {
    match crate::wire::validate_incoming(&frame) {
        Err((code, detail)) => {
            let mut err = Frame::error(code, detail);
            err.trace_id = frame.trace_id;
            err.frame_ref = frame.op_id;
            let _ = output_tx.send(err);
            return None;
        }
        Ok(_) => {}
    }
    match frame.kind {
        Kind::Inject => {
            if let Some(key) = frame_op_key(&frame) {
                if lru.check_and_insert(key) {
                    let mut err = Frame::error(ErrorCode::DuplicateOp, "duplicate_inject");
                    err.trace_id = frame.trace_id.clone();
                    err.op_id = frame.op_id.clone();
                    let _ = output_tx.send(err);
                    return None;
                }
            }
            let data = frame.data.unwrap_or_default();
            let writer = pty_writer.clone();
            let bytes = data.into_bytes();
            let _ = task::spawn_blocking(move || -> std::io::Result<()> {
                let mut w = writer.blocking_lock();
                w.write_all(&bytes)?;
                w.flush()?;
                Ok(())
            }).await;
            None
        }
        Kind::Ping => {
            let _ = output_tx.send(Frame::pong(frame.trace_id));
            None
        }
        Kind::Kill | Kind::Signal => {
            let kind = if matches!(frame.signal, Some(crate::wire::SignalKind::Sigkill))
                || frame.force.unwrap_or(false)
            {
                KillKind::Forced
            } else {
                KillKind::Graceful
            };
            Some(kind)
        }
        Kind::Delete => {
            let _ = sid; // sid validation happens via manifest read; M3 trusts the channel.
            let kind = if frame.force.unwrap_or(false) { KillKind::Forced } else { KillKind::Graceful };
            Some(kind)
        }
        // Server-emitted kinds — ignored if received from clients (per V1 ADR §6.7).
        Kind::Output | Kind::Pong | Kind::Error | Kind::ShutdownDrain | Kind::Spawn | Kind::Resize => None,
        Kind::Unknown => unreachable!("validate_incoming should have rejected Unknown"),
    }
}

fn drain_pty_to_stdout(mut reader: Box<dyn Read + Send>) -> Result<()> {
    let mut buf = [0u8; 4096];
    let mut stdout = std::io::stdout().lock();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => { stdout.write_all(&buf[..n])?; stdout.flush()?; }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Dual sink: raw bytes to stdout (M1/M2 smoke compat) + Frame::output broadcast
/// to UDS clients. Trace_id is None for unsolicited PTY emissions — clients can
/// mint downstream context. `seq` is a monotonic counter scoped to this reader.
fn drain_pty_dual(
    mut reader: Box<dyn Read + Send>,
    output_tx: broadcast::Sender<Frame>,
    sid: String,
) -> Result<()> {
    let mut buf = [0u8; 4096];
    let mut stdout = std::io::stdout().lock();
    let mut seq: u64 = 0;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                stdout.write_all(&buf[..n])?;
                stdout.flush()?;
                seq += 1;
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = output_tx.send(Frame::output(&sid, text, None, seq));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn to_wire_reason(r: ExitReason) -> ExitReasonWire {
    match r {
        ExitReason::Normal => ExitReasonWire::Normal,
        ExitReason::Signaled => ExitReasonWire::Signaled,
        ExitReason::Killed => ExitReasonWire::Killed,
        ExitReason::Crashed => ExitReasonWire::Crashed,
        ExitReason::Unkillable => ExitReasonWire::Unkillable,
    }
}

fn default_pty_size() -> PtySize {
    PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }
}
