//! Supervisor lifecycle.
//!
//! - M1 surface: [`spawn_observe`] — spawn + observe a child until natural exit.
//! - M2 surface: [`run`] — adds graceful/forced kill orchestration, manifest
//!   atomic write, signal handlers, A8 finalize (unlink clean / tombstone abnormal).
//!
//! Invariants (plan §3.1, codex F5, SPEC-C3-r1 §0.3 / §4.1.1 / §5.1 Order A):
//! - Caller drives a `tokio` current_thread runtime.
//! - All blocking syscalls (`Child::wait`, `Read::read`, `killpg`) go through
//!   `tokio::task::spawn_blocking`; the reactor never blocks.
//! - `pair.slave` is dropped immediately after spawn (§5.4).
//! - On POSIX, portable-pty's slave-spawn calls `setsid()`, so `child.process_id()`
//!   equals the child's pgid — used directly with `killpg(-pgid, …)` (§3.1).

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::oneshot;
use tokio::task;
use tokio::time::Duration;

use crate::kill_gate::{
    perform_kill, KillKind, KillOutcome, KillTimeouts, PTY_READ_DRAIN_DEADLINE_MS,
};
use crate::manifest::{
    self, now_rfc3339, ExitReason, IpcRef, KillGateConfig, Manifest, Status, SCHEMA_VERSION,
};

/// Result of a completed spawn_observe call.
#[derive(Debug)]
pub struct ObserveOutcome {
    pub exit_status: ExitStatus,
}

impl ObserveOutcome {
    pub fn exit_code(&self) -> i32 {
        if self.exit_status.success() { 0 } else { self.exit_status.exit_code() as i32 }
    }
}

/// M1 entry point: spawn `argv` under a fresh PTY, stream its output, await exit.
/// Kept as the minimal observe-only path for tests and milestones that don't need
/// kill orchestration; [`run`] is the M2+ entry point.
pub async fn spawn_observe(argv: &[OsString], cwd: Option<PathBuf>) -> Result<ObserveOutcome> {
    let (head, rest) = argv
        .split_first()
        .context("spawn_observe requires at least one argv entry")?;
    let mut builder = CommandBuilder::new(head);
    builder.args(rest);
    if let Some(dir) = cwd { builder.cwd(dir); }

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .context("openpty")?;
    let mut child = pair.slave.spawn_command(builder).context("spawn_command")?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().context("try_clone_reader")?;
    let read_task = task::spawn_blocking(move || drain_pty(reader));
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
    /// For natural exits, forward the child's code. For successful kills the
    /// supervisor itself returns 0 (SPEC-C3-r1 §1.3 step 7); abnormal exits
    /// surface via `exit_reason` (tombstone manifest, log.jsonl in M3).
    pub fn exit_code(&self) -> i32 {
        match self.exit_reason {
            ExitReason::Normal => match &self.exit_status {
                Some(s) if s.success() => 0,
                Some(s) => s.exit_code() as i32,
                None => 1,
            },
            ExitReason::Signaled | ExitReason::Killed => 0,
            ExitReason::Crashed | ExitReason::Unkillable => 0,
        }
    }
}

/// M2 entry point: spawn + observe + kill orchestration + manifest A8 finalize.
pub async fn run(cfg: SupervisorConfig) -> Result<RunOutcome> {
    let (head, rest) = cfg
        .argv
        .split_first()
        .context("supervisor config argv is empty")?;
    let mut builder = CommandBuilder::new(head);
    builder.args(rest);
    if let Some(dir) = &cfg.cwd { builder.cwd(dir); }

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .context("openpty")?;
    let mut child = pair.slave.spawn_command(builder).context("spawn_command")?;
    drop(pair.slave);

    let child_pid = child
        .process_id()
        .context("portable-pty did not return a child pid (POSIX-only)")?;
    // POSIX §3.1: portable-pty's slave-spawn calls setsid → child pid == pgid.
    let pgid: i32 = child_pid as i32;

    let session_dir = manifest::session_dir(&cfg.sid)?;
    let manifest_path = manifest::manifest_path(&cfg.sid)?;
    let live_manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        id: cfg.sid.clone(),
        pid: std::process::id(),
        ipc: IpcRef {
            kind: "uds".to_string(),
            path: session_dir.join("supervisor.sock").to_string_lossy().into_owned(),
        },
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
    tracing::info!(sid = %cfg.sid, pid = live_manifest.pid, child_pid, "supervisor ready");

    let reader = pair.master.try_clone_reader().context("try_clone_reader")?;
    let read_task = task::spawn_blocking(move || drain_pty(reader));
    drop(pair.master);

    let (wait_tx, mut wait_rx) = oneshot::channel::<std::io::Result<ExitStatus>>();
    let wait_join = task::spawn_blocking(move || {
        let result = child.wait();
        let _ = wait_tx.send(result);
    });

    let mut sigterm = signal(SignalKind::terminate()).context("install SIGTERM handler")?;
    let mut sigint = signal(SignalKind::interrupt()).context("install SIGINT handler")?;

    let outcome = tokio::select! {
        biased;
        r = &mut wait_rx => match r {
            Ok(Ok(status)) => KillOutcome::Reaped {
                exit_status: status,
                exit_reason: ExitReason::Normal,
                exit_signal: "",
                escalated: false,
            },
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => return Err(anyhow::anyhow!("child wait sender dropped before exit")),
        },
        _ = sigterm.recv() => {
            tracing::info!("SIGTERM → graceful kill");
            perform_kill(pgid, &mut wait_rx, KillKind::Graceful, cfg.kill_timeouts).await?
        }
        _ = sigint.recv() => {
            tracing::info!("SIGINT → graceful kill");
            perform_kill(pgid, &mut wait_rx, KillKind::Graceful, cfg.kill_timeouts).await?
        }
    };
    let _ = wait_join.await;

    // SPEC-C3-r1 §5.1 Order A: kill → reap → PTY drain → master close.
    // master FD was already dropped above; the read_task drains until EOF or
    // pty_read_drain_deadline_ms, whichever comes first.
    let _ = tokio::time::timeout(
        Duration::from_millis(PTY_READ_DRAIN_DEADLINE_MS),
        read_task,
    )
    .await;

    let (exit_status, exit_reason, exit_signal, escalated) = match outcome {
        KillOutcome::Reaped { exit_status, exit_reason, exit_signal, escalated } => (
            Some(exit_status),
            exit_reason,
            if exit_signal.is_empty() { None } else { Some(exit_signal.to_string()) },
            escalated,
        ),
        KillOutcome::Unkillable { last_signal } => (
            None,
            ExitReason::Unkillable,
            Some(last_signal.to_string()),
            true,
        ),
    };

    // A8: clean → unlink; abnormal → tombstone.
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

fn drain_pty(mut reader: Box<dyn Read + Send>) -> Result<()> {
    let mut buf = [0u8; 4096];
    let mut stdout = std::io::stdout().lock();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                stdout.write_all(&buf[..n])?;
                stdout.flush()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
