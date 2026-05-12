//! Phase 1 sidecar supervisor core.
//!
//! M1 scope: `supervisor::spawn_observe` (spawn child via portable-pty,
//! stream PTY output, await exit). Kill-gate, manifest, IPC, wire enums
//! land in M2/M3 per `docs/plans/2026-05-12-phase1-sidecar-spike-plan.md`.

pub mod supervisor;
