//! End-to-end UDS protocol tests — spawn supervisor in-process, connect via
//! `tokio::net::UnixStream`, drive NDJSON.
//!
//! Per dispatch §M3 invariants — real-supervisor for IPC semantics. Tests run
//! within a single process so we can rely on `tokio::spawn(run(cfg))` rather
//! than shelling out to the binary; this keeps the tests deterministic.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use telepty_supervisor_core::ipc::socket_path_for;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{session_dir, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};
use telepty_supervisor_core::wire::{ErrorCode, Frame, Kind};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;

fn unique_sid(label: &str) -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("m3-test-{}-{}-{}", label, pid, nanos)
}

fn cfg(sid: &str, argv: &[&str]) -> SupervisorConfig {
    SupervisorConfig {
        sid: sid.to_string(),
        cwd: None,
        argv: argv.iter().map(|s| OsString::from(*s)).collect(),
        kill_gate: KillGateConfig::default(),
        kill_timeouts: KillTimeouts {
            graceful: Duration::from_millis(200),
            child_reap: Duration::from_millis(200),
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

async fn send_recv(stream: &mut UnixStream, frame: &Frame) -> Option<Frame> {
    let line = frame.to_ndjson_line();
    let _ = stream.write_all(line.as_bytes()).await;
    let _ = stream.flush().await;
    let (rx, _tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();
    match timeout(Duration::from_secs(2), lines.next_line()).await {
        Ok(Ok(Some(l))) => serde_json::from_str(&l).ok(),
        _ => None,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn ping_returns_pong() {
    let sid = unique_sid("ping");
    let sock = socket_path_for(&session_dir(&sid).unwrap());
    let cfg = cfg(&sid, &["bash", "-c", "sleep 5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(
        wait_for_socket(&sock).await,
        "socket never appeared: {:?}",
        sock
    );

    let mut stream = UnixStream::connect(&sock).await.expect("connect");
    let mut ping = Frame::new(Kind::Ping);
    ping.trace_id = Some("t-ping".into());
    let reply = send_recv(&mut stream, &ping).await.expect("pong");
    assert_eq!(reply.kind, Kind::Pong);
    assert_eq!(reply.trace_id.as_deref(), Some("t-ping"));

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    let line = delete.to_ndjson_line();
    let _ = stream.write_all(line.as_bytes()).await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn inject_without_trace_id_returns_bad_frame() {
    let sid = unique_sid("notrace");
    let sock = socket_path_for(&session_dir(&sid).unwrap());
    let cfg = cfg(&sid, &["bash", "-c", "sleep 5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    wait_for_socket(&sock).await;
    let mut stream = UnixStream::connect(&sock).await.unwrap();

    let mut inject = Frame::new(Kind::Inject);
    inject.sid = Some(sid.clone());
    inject.data = Some("hi\n".into());
    // intentionally no trace_id
    let reply = send_recv(&mut stream, &inject).await.expect("error reply");
    assert_eq!(reply.kind, Kind::Error);
    assert_eq!(reply.code, Some(ErrorCode::BadFrame));
    assert_eq!(reply.data.as_deref(), Some("inject_missing_trace_id"));

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid);
    delete.trace_id = Some("t".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_kind_returns_bad_frame() {
    let sid = unique_sid("unk");
    let sock = socket_path_for(&session_dir(&sid).unwrap());
    let cfg = cfg(&sid, &["bash", "-c", "sleep 5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    wait_for_socket(&sock).await;
    let mut stream = UnixStream::connect(&sock).await.unwrap();

    let _ = stream
        .write_all(b"{\"v\":1,\"kind\":\"telepathy\",\"sid\":\"x\"}\n")
        .await;
    let (rx, _tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();
    let l = timeout(Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let reply: Frame = serde_json::from_str(&l).unwrap();
    assert_eq!(reply.kind, Kind::Error);
    assert_eq!(reply.code, Some(ErrorCode::BadFrame));
    assert_eq!(reply.data.as_deref(), Some("kind_unknown"));

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid);
    delete.trace_id = Some("t".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn v2_returns_bad_frame_version_unsupported() {
    let sid = unique_sid("v2");
    let sock = socket_path_for(&session_dir(&sid).unwrap());
    let cfg = cfg(&sid, &["bash", "-c", "sleep 5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    wait_for_socket(&sock).await;
    let mut stream = UnixStream::connect(&sock).await.unwrap();

    let _ = stream.write_all(b"{\"v\":2,\"kind\":\"ping\"}\n").await;
    let (rx, _tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();
    let l = timeout(Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let reply: Frame = serde_json::from_str(&l).unwrap();
    assert_eq!(reply.code, Some(ErrorCode::BadFrame));
    assert_eq!(reply.data.as_deref(), Some("version_unsupported"));

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid);
    delete.trace_id = Some("t".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn duplicate_inject_op_id_returns_duplicate_op() {
    let sid = unique_sid("dup");
    let sock = socket_path_for(&session_dir(&sid).unwrap());
    let cfg = cfg(&sid, &["bash", "-c", "sleep 5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    wait_for_socket(&sock).await;
    let mut stream = UnixStream::connect(&sock).await.unwrap();

    let mut inject = Frame::new(Kind::Inject);
    inject.sid = Some(sid.clone());
    inject.trace_id = Some("t-1".into());
    inject.op_id = Some("op-dup".into());
    inject.data = Some("# dup test\n".into());
    let _ = stream.write_all(inject.to_ndjson_line().as_bytes()).await;
    // Second inject with same op_id.
    let _ = stream.write_all(inject.to_ndjson_line().as_bytes()).await;

    // Collect a few output frames; one should be the duplicate error.
    let (rx, _tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();
    let mut saw_dup = false;
    for _ in 0..20 {
        let r = timeout(Duration::from_millis(500), lines.next_line()).await;
        let Ok(Ok(Some(l))) = r else { break };
        if let Ok(f) = serde_json::from_str::<Frame>(&l) {
            if f.kind == Kind::Error && f.code == Some(ErrorCode::DuplicateOp) {
                saw_dup = true;
                break;
            }
        }
    }
    assert!(saw_dup, "expected ERR_DUPLICATE_OP from second inject");

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid);
    delete.trace_id = Some("t".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = h.await;
}
