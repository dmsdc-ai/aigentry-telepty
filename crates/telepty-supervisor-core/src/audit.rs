//! G3 audit trail — append-only `log.jsonl` per session.
//!
//! Path: `~/.telepty/sessions/<sid>/log.jsonl`. Each line is a serialized
//! `wire::Frame` (NDJSON). Phase 1 scope per dispatch L48-49 + L86 (G3 minimal):
//! - Output frames emitted by the PTY reader → logged for A5 reattach replay.
//! - ShutdownDrain on terminal → logged so a late reattach still sees terminal.
//! - All other broadcast traffic (pong, error, internal) is NOT logged in P1
//!   to keep file size bounded; G3 expansion (ingest events + lifecycle audit)
//!   is a deliberate Phase 4 follow-up if synthesis ADR §G3 demands it.
//!
//! Concurrency: a single `std::sync::Mutex<BufWriter<File>>`. The PTY reader
//! lives in `spawn_blocking`; the supervisor lifecycle writer (shutdown_drain)
//! is called from async but the lock window is short (one serialize + write).
//! No rotation in P1 — Constitution §1 lightweight; rotation lands when a real
//! session demonstrates the need.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};

use crate::wire::Frame;

pub const LOG_FILENAME: &str = "log.jsonl";

pub struct AuditLogger {
    path: PathBuf,
    inner: Mutex<BufWriter<fs::File>>,
}

impl AuditLogger {
    /// Open (or create) `<session_dir>/log.jsonl` for append. Parent dir must
    /// exist (supervisor::run creates it via manifest::write_atomic earlier).
    pub fn open(session_dir: &Path) -> Result<Self> {
        let path = session_dir.join(LOG_FILENAME);
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open audit log {}", path.display()))?;
        Ok(Self {
            path,
            inner: Mutex::new(BufWriter::new(file)),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a serialized frame as one NDJSON line. POSIX append writes ≤PIPE_BUF
    /// (typically 4096 B) are atomic across processes; our `BufWriter` flush per
    /// call keeps the on-disk view monotonic for concurrent readers.
    pub fn append(&self, frame: &Frame) -> Result<()> {
        let line = frame.to_ndjson_line();
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("audit logger mutex poisoned"))?;
        guard.write_all(line.as_bytes()).context("audit append")?;
        guard.flush().context("audit flush")?;
        Ok(())
    }
}

/// Helper for callers that already hold the session_dir path.
pub fn log_path(session_dir: &Path) -> PathBuf {
    session_dir.join(LOG_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Kind;

    #[test]
    fn append_creates_and_writes_ndjson_line() {
        let tmp = std::env::temp_dir().join(format!(
            "telepty-audit-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let logger = AuditLogger::open(&tmp).unwrap();
        let mut f = Frame::new(Kind::Output);
        f.sid = Some("s".into());
        f.seq = Some(1);
        f.data = Some("hi".into());
        logger.append(&f).unwrap();

        let contents = fs::read_to_string(logger.path()).unwrap();
        assert!(contents.ends_with('\n'));
        assert!(contents.contains("\"kind\":\"output\""));
        assert!(contents.contains("\"seq\":1"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn multiple_appends_preserve_order() {
        let tmp = std::env::temp_dir().join(format!(
            "telepty-audit-order-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let logger = AuditLogger::open(&tmp).unwrap();
        for i in 1u64..=5 {
            let mut f = Frame::new(Kind::Output);
            f.sid = Some("s".into());
            f.seq = Some(i);
            f.data = Some(format!("chunk-{}", i));
            logger.append(&f).unwrap();
        }
        let contents = fs::read_to_string(logger.path()).unwrap();
        let lines: Vec<&str> = contents.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 5);
        for (idx, l) in lines.iter().enumerate() {
            let f: Frame = serde_json::from_str(l).unwrap();
            assert_eq!(f.seq, Some((idx + 1) as u64));
        }
        let _ = fs::remove_dir_all(&tmp);
    }
}
