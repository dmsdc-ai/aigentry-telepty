//! A8 delete graceful drain integration test.
//!
//! Per orchestrator §A8 contract: SIGTERM → drain pending IPC → manifest unlink
//! → log final entry → exit clean within grace. End-to-end test (no goldens) —
//! spawns a real supervisor, exercises the wire path through `Kind::Delete`,
//! and asserts on filesystem state + log.jsonl tail.
//!
//! Forced variant (`force:true`) covers SIGKILL path.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use telepty_supervisor_core::audit::log_path;
use telepty_supervisor_core::ipc::socket_path_for;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{manifest_path, session_dir, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};
use telepty_supervisor_core::wire::{ExitReasonWire, Frame, Kind};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

fn unique_sid(label: &str) -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("a8-test-{}-{}-{}", label, pid, nanos)
}

fn cfg(sid: &str, argv: &[&str]) -> SupervisorConfig {
    SupervisorConfig {
        sid: sid.to_string(),
        cwd: None,
        argv: argv.iter().map(|s| OsString::from(*s)).collect(),
        kill_gate: KillGateConfig::default(),
        kill_timeouts: KillTimeouts {
            graceful: Duration::from_millis(500),
            child_reap: Duration::from_millis(500),
        },
    }
}

async fn wait_for_socket(path: &Path) -> bool {
    for _ in 0..50 {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    false
}

fn read_audit_tail(log: &Path) -> Vec<Frame> {
    let Ok(contents) = std::fs::read_to_string(log) else { return Vec::new() };
    contents
        .lines()
        .filter_map(|l| serde_json::from_str::<Frame>(l).ok())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn delete_graceful_drains_and_unlinks_manifest_and_socket() {
    let sid = unique_sid("graceful");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let mp = manifest_path(&sid).unwrap();
    let log = log_path(&dir);

    // `sleep 60` honors default SIGTERM action (terminate) so graceful path
    // reaps the child cleanly within grace.
    let cfg = cfg(&sid, &["sleep", "60"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(wait_for_socket(&sock).await, "socket never appeared");
    assert!(mp.exists(), "manifest never written");

    let mut stream = UnixStream::connect(&sock).await.expect("connect");
    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    // No force — exercises SIGTERM-first path.
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = stream.flush().await;

    // Supervisor must complete within 3s (grace 500ms + reap 500ms + headroom).
    let outcome = tokio::time::timeout(Duration::from_secs(3), h)
        .await
        .expect("supervisor did not exit within 3s")
        .expect("join error")
        .expect("run error");

    // ---- A8 invariants ----
    assert!(!mp.exists(), "manifest must be unlinked on clean exit; still at {}", mp.display());
    assert!(!sock.exists(), "socket must be unlinked on clean exit; still at {}", sock.display());

    // log.jsonl must exist and final entry must be shutdown_drain with exit_reason ∈ {signaled, killed}.
    assert!(log.exists(), "log.jsonl must persist as audit artifact");
    let tail = read_audit_tail(&log);
    let final_drain = tail.iter().rev().find(|f| f.kind == Kind::ShutdownDrain);
    let final_drain = final_drain.expect("log.jsonl must contain a shutdown_drain entry");
    assert!(
        matches!(
            final_drain.exit_reason,
            Some(ExitReasonWire::Signaled) | Some(ExitReasonWire::Killed)
        ),
        "expected signaled or killed, got {:?}",
        final_drain.exit_reason
    );

    // Outcome: exit_code 0 (graceful kill is clean per SPEC §1.3.7).
    assert_eq!(outcome.exit_code(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn delete_forced_skips_grace_and_unlinks() {
    let sid = unique_sid("forced");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let mp = manifest_path(&sid).unwrap();
    let log = log_path(&dir);

    // `sleep 60` with force=true should be SIGKILL'd immediately, no graceful wait.
    let cfg = cfg(&sid, &["sleep", "60"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(wait_for_socket(&sock).await);
    assert!(mp.exists());

    let mut stream = UnixStream::connect(&sock).await.unwrap();
    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = stream.flush().await;

    let outcome = tokio::time::timeout(Duration::from_secs(3), h)
        .await
        .expect("supervisor did not exit within 3s for forced delete")
        .expect("join error")
        .expect("run error");

    assert!(!mp.exists(), "manifest must be unlinked after forced delete");
    assert!(!sock.exists(), "socket must be unlinked after forced delete");
    assert!(log.exists());
    let tail = read_audit_tail(&log);
    let final_drain = tail
        .iter()
        .rev()
        .find(|f| f.kind == Kind::ShutdownDrain)
        .expect("forced delete must still emit shutdown_drain");
    assert_eq!(final_drain.exit_reason, Some(ExitReasonWire::Killed));
    assert_eq!(outcome.exit_code(), 0);
}
