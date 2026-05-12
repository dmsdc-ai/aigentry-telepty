//! Phase 1 sidecar supervisor core.
//!
//! Per `docs/plans/2026-05-12-phase1-sidecar-spike-plan.md`:
//! - M1: `supervisor::spawn_observe` — spawn child via portable-pty, stream PTY.
//! - M2: `manifest` + `kill_gate` + `supervisor::run` — graceful + forced kill,
//!   atomic manifest write (F4), A8 unlink on clean / tombstone on abnormal.
//! - M3 will add `wire` + `ipc`.

pub mod kill_gate;
pub mod manifest;
pub mod supervisor;
