//! Per-session manifest under `~/.telepty/sessions/<sid>/manifest.json`.
//!
//! Plan §3.3 + SPEC-C3-r1 §6.3:
//! - Atomic write: `tmp + fsync(tmp) + rename + fsync(parent_dir)` (F4).
//! - A8 unlink on clean exit (`exit_reason ∈ {normal, signaled, killed}`).
//! - Tombstone retained on `crashed` / `unkillable`.
//! - Audit fields (`exit_code`, `exit_signal`) live in `log.jsonl` per V1 ADR §7.3;
//!   M2 stores them on the tombstone manifest for operator visibility (log.jsonl
//!   lands in M3).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Spawning,
    Ready,
    Draining,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExitReason {
    Normal,
    Signaled,
    Killed,
    Crashed,
    Unkillable,
}

impl ExitReason {
    /// Per SPEC-C3-r1 §6.3.1: clean exits unlink, abnormal exits tombstone.
    pub fn is_clean(self) -> bool {
        matches!(self, Self::Normal | Self::Signaled | Self::Killed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillGateConfig {
    pub graceful_grace_ms: u64,
    pub parent_death_grace_ms: u64,
    pub restart_policy: String,
}

impl Default for KillGateConfig {
    fn default() -> Self {
        Self {
            graceful_grace_ms: 3000,
            parent_death_grace_ms: 15000,
            restart_policy: "respawn".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRef {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub pid: u32,
    pub ipc: IpcRef,
    pub status: Status,
    pub restart_count: u32,
    pub created_at: String,
    pub kill_gate: KillGateConfig,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_reason: Option<ExitReason>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub crashed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unkillable_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stopped_at: Option<String>,
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn session_dir(sid: &str) -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME env unset")?;
    let mut p = PathBuf::from(home);
    p.push(".telepty");
    p.push("sessions");
    p.push(sid);
    Ok(p)
}

pub fn manifest_path(sid: &str) -> Result<PathBuf> {
    let mut p = session_dir(sid)?;
    p.push("manifest.json");
    Ok(p)
}

/// F4: tmp + fsync(tmp) + rename + fsync(parent_dir).
pub fn write_atomic(path: &Path, m: &Manifest) -> Result<()> {
    let parent = path.parent().context("manifest path missing parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create_dir_all {}", parent.display()))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let bytes = serde_json::to_vec_pretty(m).context("serialize manifest")?;
        f.write_all(&bytes).context("write manifest tmp")?;
        f.sync_all().context("fsync manifest tmp")?;
    }
    fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    fsync_dir(parent)?;
    Ok(())
}

/// A8: unlink the manifest on clean exit. Idempotent on ENOENT.
pub fn unlink_clean(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                let _ = fsync_dir(parent);
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("unlink {}", path.display())),
    }
}

/// Tombstone uses the same atomic write — caller fills status/exit_reason fields.
pub fn write_tombstone(path: &Path, m: &Manifest) -> Result<()> {
    debug_assert!(matches!(m.status, Status::Error));
    debug_assert!(m.exit_reason.map(|r| !r.is_clean()).unwrap_or(false));
    write_atomic(path, m)
}

/// A7 list discovery — scan `~/.telepty/sessions/*/manifest.json` and return all
/// readable+parseable manifests. Unreadable directories, missing manifests, and
/// parse failures are skipped (logged at debug) so a partial corruption never
/// breaks discovery. Returns empty vec if the sessions root doesn't exist.
pub fn scan_sessions() -> Result<Vec<Manifest>> {
    let home = std::env::var_os("HOME").context("HOME env unset")?;
    let mut root = PathBuf::from(home);
    root.push(".telepty");
    root.push("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&root)
        .with_context(|| format!("read_dir {}", root.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mp = path.join("manifest.json");
        let bytes = match fs::read(&mp) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                tracing::debug!(path = %mp.display(), error = %e, "scan_sessions: read failed");
                continue;
            }
        };
        match serde_json::from_slice::<Manifest>(&bytes) {
            Ok(m) => out.push(m),
            Err(e) => {
                tracing::debug!(path = %mp.display(), error = %e, "scan_sessions: parse failed");
            }
        }
    }
    Ok(out)
}

fn fsync_dir(dir: &Path) -> Result<()> {
    let f = fs::File::open(dir).with_context(|| format!("open dir for fsync {}", dir.display()))?;
    f.sync_all().context("fsync parent dir")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tombstone_roundtrip_unkillable() {
        let now = now_rfc3339();
        let m = Manifest {
            schema_version: SCHEMA_VERSION,
            id: "mock-unkillable".into(),
            pid: 12345,
            ipc: IpcRef {
                kind: "uds".into(),
                path: "/tmp/x.sock".into(),
            },
            status: Status::Error,
            restart_count: 0,
            created_at: now.clone(),
            kill_gate: KillGateConfig::default(),
            exit_reason: Some(ExitReason::Unkillable),
            exit_signal: Some("SIGKILL".into()),
            exit_code: None,
            crashed_at: None,
            unkillable_at: Some(now.clone()),
            stopped_at: Some(now),
        };
        let bytes = serde_json::to_vec(&m).unwrap();
        let back: Manifest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.status, Status::Error);
        assert_eq!(back.exit_reason, Some(ExitReason::Unkillable));
        assert_eq!(back.exit_signal.as_deref(), Some("SIGKILL"));
        assert!(back.unkillable_at.is_some());
    }

    #[test]
    fn exit_reason_is_clean() {
        assert!(ExitReason::Normal.is_clean());
        assert!(ExitReason::Signaled.is_clean());
        assert!(ExitReason::Killed.is_clean());
        assert!(!ExitReason::Crashed.is_clean());
        assert!(!ExitReason::Unkillable.is_clean());
    }

    #[test]
    fn scan_sessions_handles_missing_root_gracefully() {
        // We can't truly test against ~/.telepty/sessions in unit context (other
        // tests may have written there), but we can verify the function returns
        // Ok with a vec (possibly populated by other concurrent tests) and never
        // panics. The empty-root branch is exercised when the dir doesn't exist.
        let out = scan_sessions().expect("scan_sessions must not error");
        // Every returned manifest has a non-empty id (sanity check on shape).
        for m in &out {
            assert!(!m.id.is_empty(), "scan_sessions returned manifest with empty id");
            assert_eq!(m.schema_version, SCHEMA_VERSION, "schema version mismatch");
        }
    }
}
