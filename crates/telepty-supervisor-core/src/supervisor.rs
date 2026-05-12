//! M1 supervisor: spawn + observe.
//!
//! Plan §3.1 final shape is `run(SupervisorConfig) -> Result<()>`. M1 only needs
//! `spawn_observe`: open a PTY, spawn the child, stream output, await exit.
//! Manifest/IPC/kill-gate are M2/M3.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::task;

/// Result of a completed spawn_observe call.
#[derive(Debug)]
pub struct ObserveOutcome {
    /// Child exit status as reported by portable-pty's `Child::wait`.
    pub exit_status: portable_pty::ExitStatus,
}

impl ObserveOutcome {
    /// Best-effort exit code for the process. portable-pty does not currently
    /// distinguish signal-terminated children on POSIX (signal handling is M2),
    /// so non-success children that lack an explicit code map to 1.
    pub fn exit_code(&self) -> i32 {
        if self.exit_status.success() {
            0
        } else {
            self.exit_status.exit_code() as i32
        }
    }
}

/// Spawn `argv` under a fresh PTY, stream its output to stdout, await exit.
///
/// Invariants (plan §3.1, codex F5, SPEC-C3-r1 §4.1.1):
/// - Caller drives a `tokio` current_thread runtime.
/// - All blocking calls (`Child::wait`, `Read::read`) go through
///   `tokio::task::spawn_blocking`; we never block the reactor.
/// - `pair.slave` is dropped immediately after spawn per portable-pty docs.
pub async fn spawn_observe(argv: &[OsString], cwd: Option<PathBuf>) -> Result<ObserveOutcome> {
    let (head, rest) = argv
        .split_first()
        .context("spawn_observe requires at least one argv entry (the program)")?;

    let mut builder = CommandBuilder::new(head);
    builder.args(rest);
    if let Some(dir) = cwd {
        builder.cwd(dir);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty failed")?;

    let mut child = pair
        .slave
        .spawn_command(builder)
        .context("spawn_command failed")?;
    // PtyPair semantics: drop the slave once the child has it, or subsequent
    // reads on the master may block waiting for an extra writer.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("try_clone_reader failed")?;

    let read_task = task::spawn_blocking(move || -> Result<()> {
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
    });

    // Drop our master handle once the reader has cloned it. portable-pty
    // requires keeping at least one master alive while the child runs, but the
    // reader clone owns its own handle.
    drop(pair.master);

    let wait_task = task::spawn_blocking(move || -> Result<portable_pty::ExitStatus> {
        let status = child.wait().context("child wait failed")?;
        Ok(status)
    });

    let exit_status = wait_task.await.context("wait join failed")??;

    // Reader task drains the PTY; surface read errors but treat post-exit EOF
    // as expected.
    match read_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "pty read loop error"),
        Err(e) => tracing::warn!(error = %e, "pty read task join error"),
    }

    Ok(ObserveOutcome { exit_status })
}
