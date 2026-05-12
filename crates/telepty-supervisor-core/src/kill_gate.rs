//! Kill-gate state machine (SPEC-C3-r1 §1.2 / §1.3 / §4 / §5; plan §3.5).
//!
//! M2 scope: graceful (SIGTERM via `killpg(-pgid)`) → grace timeout → escalate
//! to SIGKILL → child reap timeout → Unkillable. Forced (`force:true`) skips
//! SIGTERM. All blocking syscalls (`killpg`) go through `spawn_blocking` per
//! plan §7.R3 / SPEC-C3-r1 §0.3.
//!
//! Q2 measurement note (Phase 1 §4.2.C; binding-pre-M2 acceptance per F13 r2):
//! `GRACEFUL_GRACE_MS = 3000` is marked PROPOSED in SPEC-C3-r1 §2.1.
//! Measurement protocol: spawn supervisor wrapping claude/codex/gemini × 5
//! sample prompts each; after final meaningful output, send SIGTERM and record
//! wall-clock delta from SIGTERM → PTY master EOF. Tally per-CLI p50/p99.
//! Accept default if `max p99 < 3000ms`; else file follow-up to raise the
//! default or expose per-CLI override (Phase 2 config plumbing).
//!
//! M2 status: default retained — measurement requires interactive REPL access
//! that this autonomous spike session lacks. The smoke harness exercises the
//! escalation path with `trap "" TERM` so the 3000 ms gate is itself proven;
//! a real-CLI Q2 run is logged as a follow-up for the orchestrator.

use std::time::Duration;

use anyhow::{Context, Result};
use nix::errno::Errno;
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use portable_pty::ExitStatus;
use tokio::sync::oneshot;
use tokio::task;
use tokio::time::timeout;

use crate::manifest::ExitReason;

pub const GRACEFUL_GRACE_MS: u64 = 3000;
pub const CHILD_REAP_TIMEOUT_MS: u64 = 2000;
pub const PTY_READ_DRAIN_DEADLINE_MS: u64 = 500;

#[derive(Debug, Clone, Copy)]
pub enum KillKind {
    Graceful,
    Forced,
}

#[derive(Debug, Clone, Copy)]
pub struct KillTimeouts {
    pub graceful: Duration,
    pub child_reap: Duration,
}

impl Default for KillTimeouts {
    fn default() -> Self {
        Self {
            graceful: Duration::from_millis(GRACEFUL_GRACE_MS),
            child_reap: Duration::from_millis(CHILD_REAP_TIMEOUT_MS),
        }
    }
}

#[derive(Debug)]
pub enum KillOutcome {
    Reaped {
        exit_status: ExitStatus,
        exit_reason: ExitReason,
        exit_signal: &'static str,
        escalated: bool,
    },
    Unkillable {
        last_signal: &'static str,
    },
}

pub type WaitChannel = oneshot::Receiver<std::io::Result<ExitStatus>>;

/// Run the kill gate against `pgid`, using `wait_rx` to learn when the child
/// has been reaped. Caller owns the reaping side (spawn_blocking on
/// `Child::wait`) and forwards the result into `wait_rx`.
pub async fn perform_kill(
    pgid: i32,
    wait_rx: &mut WaitChannel,
    kind: KillKind,
    timeouts: KillTimeouts,
) -> Result<KillOutcome> {
    let mut escalated = false;

    if matches!(kind, KillKind::Graceful) {
        send_pgrp_signal(pgid, Signal::SIGTERM).await?;
        match timeout(timeouts.graceful, &mut *wait_rx).await {
            Ok(Ok(Ok(status))) => {
                return Ok(KillOutcome::Reaped {
                    exit_status: status,
                    exit_reason: ExitReason::Signaled,
                    exit_signal: "SIGTERM",
                    escalated: false,
                });
            }
            Ok(Ok(Err(e))) => return Err(anyhow::Error::from(e)),
            Ok(Err(_)) | Err(_) => {
                escalated = true;
                tracing::warn!(
                    grace_ms = timeouts.graceful.as_millis() as u64,
                    "graceful grace elapsed; escalating to SIGKILL"
                );
            }
        }
    }

    send_pgrp_signal(pgid, Signal::SIGKILL).await?;
    match timeout(timeouts.child_reap, &mut *wait_rx).await {
        Ok(Ok(Ok(status))) => Ok(KillOutcome::Reaped {
            exit_status: status,
            exit_reason: ExitReason::Killed,
            exit_signal: "SIGKILL",
            escalated,
        }),
        Ok(Ok(Err(e))) => Err(anyhow::Error::from(e)),
        Ok(Err(_)) | Err(_) => Ok(KillOutcome::Unkillable {
            last_signal: "SIGKILL",
        }),
    }
}

async fn send_pgrp_signal(pgid: i32, sig: Signal) -> Result<()> {
    task::spawn_blocking(move || -> Result<()> {
        match killpg(Pid::from_raw(pgid), sig) {
            Ok(()) => Ok(()),
            Err(Errno::ESRCH) => Ok(()),
            Err(e) => Err(anyhow::Error::from(e)),
        }
    })
    .await
    .context("killpg join")?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M2-faults MockChild equivalent — a `wait_rx` whose sender is intentionally
    /// leaked so the receiver never resolves. Combined with a nonexistent pgid
    /// (killpg → ESRCH, tolerated) this drives perform_kill into the Unkillable
    /// branch deterministically without spawning a real child. Per r2-patches
    /// Patch 3, MockChild covers tombstone/fault-injection unit coverage only;
    /// real OS kill semantics are exercised by integration smokes.
    #[tokio::test]
    async fn forced_kill_returns_unkillable_when_wait_never_resolves() {
        let (tx, mut rx) = oneshot::channel::<std::io::Result<ExitStatus>>();
        std::mem::forget(tx);
        let timeouts = KillTimeouts {
            graceful: Duration::from_millis(10),
            child_reap: Duration::from_millis(50),
        };
        let outcome = perform_kill(99_999_999, &mut rx, KillKind::Forced, timeouts)
            .await
            .expect("perform_kill should not error on ESRCH");
        match outcome {
            KillOutcome::Unkillable { last_signal } => {
                assert_eq!(last_signal, "SIGKILL");
            }
            other => panic!("expected Unkillable, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn graceful_escalates_when_wait_never_resolves() {
        let (tx, mut rx) = oneshot::channel::<std::io::Result<ExitStatus>>();
        std::mem::forget(tx);
        let timeouts = KillTimeouts {
            graceful: Duration::from_millis(10),
            child_reap: Duration::from_millis(50),
        };
        let outcome = perform_kill(99_999_999, &mut rx, KillKind::Graceful, timeouts)
            .await
            .unwrap();
        assert!(matches!(outcome, KillOutcome::Unkillable { last_signal: "SIGKILL" }));
    }
}
