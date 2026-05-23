//! Per-session UDS server + NDJSON ingest queue.
//!
//! Architecture (plan §3.4, codex F5, SPEC-C3-r1 §7.G):
//! - One `UnixListener` at `manifest.ipc.path`
//!   (`~/.telepty/sessions/<sid>/supervisor.sock`).
//!   Path mismatch note: dispatch mentioned `~/.aigentry/.../ipc.sock`;
//!   spec §1.1 + plan §3.4 + the shipped M2 manifest declare
//!   `.telepty/.../supervisor.sock`, so we honor the binding sources.
//! - Per-connection task reads NDJSON line-by-line, parses to `wire::Frame`, and
//!   enqueues `(ConnId, Frame)` onto a single `mpsc::channel` consumed by the
//!   supervisor — establishes the global FIFO ordering F5 requires.
//! - Output frames flow the other way via a `broadcast::channel`; per-conn tasks
//!   subscribe and forward to their socket.
//! - Idempotency LRU per supervisor (size 64) for `inject` and `delete` op_ids
//!   per §6.5 / dispatch L107.

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

use crate::wire::{ErrorCode, Frame, Kind};

pub const IPC_QUEUE_DEPTH: usize = 256;
pub const OUTPUT_BROADCAST_DEPTH: usize = 256;
pub const IDEMPOTENCY_LRU_SIZE: usize = 64;

pub type ConnId = u64;

#[derive(Debug)]
pub struct Ingest {
    pub conn_id: ConnId,
    pub frame: Frame,
    pub raw_line: String,
}

/// Bind the UDS socket at `path`, removing any stale inode first. Permissions
/// follow plan §3.4: 0700 dir / 0600 socket (M22). Caller owns lifetime of the
/// returned `UnixListener`; on drop the kernel releases the socket but the inode
/// must be unlinked explicitly on clean exit (`unlink_socket`).
pub fn bind_socket(path: &Path) -> Result<UnixListener> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create_dir_all {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("unlink stale socket"),
    }
    let listener = UnixListener::bind(path)
        .with_context(|| format!("bind UnixListener at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(listener)
}

pub fn unlink_socket(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Drives the per-session UDS accept loop. Spawns a task per accepted connection
/// that reads NDJSON, parses to `wire::Frame`, and forwards to `ingest_tx`. Each
/// connection task also subscribes to `output_tx` and writes outbound frames.
/// The accept loop terminates when `shutdown_rx` fires.
pub async fn serve(
    listener: UnixListener,
    ingest_tx: mpsc::Sender<Ingest>,
    output_tx: broadcast::Sender<Frame>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    log_path: PathBuf,
) {
    let mut next_conn_id: ConnId = 0;
    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() { break; }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        next_conn_id += 1;
                        let cid = next_conn_id;
                        let ingest_tx = ingest_tx.clone();
                        let output_rx = output_tx.subscribe();
                        let log_path = log_path.clone();
                        tokio::spawn(handle_connection(cid, stream, ingest_tx, output_rx, log_path));
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "UDS accept failed; continuing");
                    }
                }
            }
        }
    }
}

async fn handle_connection(
    conn_id: ConnId,
    stream: UnixStream,
    ingest_tx: mpsc::Sender<Ingest>,
    mut output_rx: broadcast::Receiver<Frame>,
    log_path: PathBuf,
) {
    let (reader_half, mut writer_half) = stream.into_split();
    let reader = BufReader::new(reader_half);
    let mut lines = reader.lines();
    let mut input_eof = false;

    loop {
        // After input EOF, keep draining output for up to DRAIN_AFTER_EOF_MS so
        // in-flight responses (e.g., pong for a ping the client sent then closed
        // their write half) still reach the client.
        const DRAIN_AFTER_EOF_MS: u64 = 300;
        if input_eof {
            match tokio::time::timeout(
                tokio::time::Duration::from_millis(DRAIN_AFTER_EOF_MS),
                output_rx.recv(),
            )
            .await
            {
                Ok(Ok(frame)) => {
                    if writer_half
                        .write_all(frame.to_ndjson_line().as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Err(_) => break,
            }
            continue;
        }

        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(raw)) => {
                    let parsed: Result<Frame, _> = serde_json::from_str(&raw);
                    let frame = match parsed {
                        Ok(f) => f,
                        Err(e) => {
                            let err = Frame::error(ErrorCode::BadFrame, format!("parse: {}", e));
                            let _ = writer_half.write_all(err.to_ndjson_line().as_bytes()).await;
                            continue;
                        }
                    };
                    // A5: Resume is handler-local — replay log.jsonl, do not enqueue.
                    if frame.kind == Kind::Resume {
                        let from_seq = frame.from_seq.unwrap_or(0);
                        if let Err(e) = replay_log(&log_path, from_seq, &mut writer_half).await {
                            tracing::warn!(conn_id, error = %e, "A5 replay failed");
                            let err = Frame::error(ErrorCode::BadFrame, format!("replay: {}", e));
                            let _ = writer_half.write_all(err.to_ndjson_line().as_bytes()).await;
                        }
                        continue;
                    }
                    let send = Ingest { conn_id, frame, raw_line: raw };
                    if ingest_tx.send(send).await.is_err() { break; }
                }
                Ok(None) => { input_eof = true; }
                Err(e) => {
                    tracing::warn!(conn_id, error = %e, "UDS read error; closing");
                    break;
                }
            },
            broadcast = output_rx.recv() => match broadcast {
                Ok(frame) => {
                    if writer_half.write_all(frame.to_ndjson_line().as_bytes()).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let warn = Frame::error(ErrorCode::BadFrame, "broadcast_lagged");
                    let _ = writer_half.write_all(warn.to_ndjson_line().as_bytes()).await;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

/// A5 replay: read `log.jsonl` line-by-line and forward frames whose seq is
/// > `from_seq` to the writer half. Output frames are the primary replay
/// target; other audit kinds (shutdown_drain, etc.) are also forwarded so a
/// late reattach observes terminal events. ENOENT (log not yet written) is
/// treated as empty replay per spike-lightweight semantics.
async fn replay_log(
    log_path: &Path,
    from_seq: u64,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    use tokio::fs;
    use tokio::io::AsyncBufReadExt as _;
    let file = match fs::File::open(log_path).await {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).context("open log.jsonl"),
    };
    let mut lines = tokio::io::BufReader::new(file).lines();
    while let Some(line) = lines.next_line().await.context("read log line")? {
        let Ok(frame): Result<Frame, _> = serde_json::from_str(&line) else { continue };
        match frame.seq {
            Some(s) if s > from_seq => {
                writer
                    .write_all(frame.to_ndjson_line().as_bytes())
                    .await
                    .context("replay write")?;
            }
            None => {
                // Seq-less frames (e.g., shutdown_drain) — forward unconditionally
                // so late reattach sees terminal events.
                writer
                    .write_all(frame.to_ndjson_line().as_bytes())
                    .await
                    .context("replay write seq-less")?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// O(N) LRU for idempotency keys. N ≤ 64 so the linear scan is negligible.
/// Per dispatch L107 + plan §3.4 ipc: only used by `inject` / `delete` op_ids.
#[derive(Debug, Default)]
pub struct IdempotencyLru {
    keys: VecDeque<String>,
}

impl IdempotencyLru {
    pub fn new() -> Self {
        Self {
            keys: VecDeque::new(),
        }
    }

    /// Returns true if the key was already seen (= duplicate). Otherwise records
    /// it as the freshest entry and returns false.
    pub fn check_and_insert(&mut self, key: &str) -> bool {
        if self.keys.iter().any(|k| k == key) {
            return true;
        }
        if self.keys.len() >= IDEMPOTENCY_LRU_SIZE {
            self.keys.pop_front();
        }
        self.keys.push_back(key.to_string());
        false
    }
}

/// Convenience helper: extract the idempotency key from a frame (op_id falls
/// back to idempotency_key per V1 ADR §6.5).
pub fn frame_op_key(frame: &Frame) -> Option<&str> {
    frame.op_id.as_deref().or(frame.idempotency_key.as_deref())
}

/// Standardized session socket path under `~/.telepty/sessions/<sid>/`.
pub fn socket_path_for(session_dir: &Path) -> PathBuf {
    session_dir.join("supervisor.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_dedupes_repeats() {
        let mut lru = IdempotencyLru::new();
        assert!(!lru.check_and_insert("k1"));
        assert!(lru.check_and_insert("k1"));
        assert!(!lru.check_and_insert("k2"));
        assert!(lru.check_and_insert("k2"));
    }

    #[test]
    fn lru_evicts_when_full() {
        let mut lru = IdempotencyLru::new();
        for i in 0..IDEMPOTENCY_LRU_SIZE {
            assert!(!lru.check_and_insert(&format!("k{}", i)));
        }
        // First key still present (we haven't overflowed yet).
        assert!(lru.check_and_insert("k0"));
        // Push one more — evicts k0.
        assert!(!lru.check_and_insert("knew"));
        assert!(!lru.check_and_insert("k0")); // re-inserted as fresh
    }
}
