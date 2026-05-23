//! A5 reattach / log offset replay integration tests.
//!
//! Spawns a real supervisor wrapping `cat` so we control PTY output deterministically,
//! injects content, disconnects, then reconnects with `Kind::Resume` and asserts that
//! the replay stream contains the prior Output frames with monotonically growing seq.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use telepty_supervisor_core::audit::log_path;
use telepty_supervisor_core::ipc::socket_path_for;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{session_dir, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};
use telepty_supervisor_core::wire::{Frame, Kind};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;

fn unique_sid(label: &str) -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("a5-test-{}-{}-{}", label, pid, nanos)
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

async fn wait_for_log_with_seq(log: &Path, want_seq: u64, max_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(max_ms);
    while std::time::Instant::now() < deadline {
        if let Ok(contents) = tokio::fs::read_to_string(log).await {
            for line in contents.lines() {
                if let Ok(f) = serde_json::from_str::<Frame>(line) {
                    if f.kind == Kind::Output && f.seq.unwrap_or(0) >= want_seq {
                        return true;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    false
}

#[tokio::test(flavor = "current_thread")]
async fn resume_replays_output_frames_with_higher_seq() {
    let sid = unique_sid("basic");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let log = log_path(&dir);
    // Use `cat` so each inject becomes a deterministic PTY echo. `cat` exits on EOF
    // which the kill flow triggers via SIGTERM on Delete.
    let cfg = cfg(&sid, &["cat"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(
        wait_for_socket(&sock).await,
        "socket never appeared: {:?}",
        sock
    );

    // First connection: drive two injects, then drop the socket.
    {
        let mut stream = UnixStream::connect(&sock).await.expect("connect-1");
        for (i, payload) in ["alpha\n", "beta\n"].iter().enumerate() {
            let mut inject = Frame::new(Kind::Inject);
            inject.sid = Some(sid.clone());
            inject.trace_id = Some(format!("t-{}", i + 1));
            inject.op_id = Some(format!("op-{}", i + 1));
            inject.data = Some(payload.to_string());
            stream
                .write_all(inject.to_ndjson_line().as_bytes())
                .await
                .unwrap();
        }
        let _ = stream.flush().await;
        // Wait until audit log shows at least seq=2 (each echo line is one output chunk).
        // Even if `cat` coalesces into a single read, seq>=1 is enough for replay coverage.
        assert!(
            wait_for_log_with_seq(&log, 1, 2000).await,
            "audit log never saw any seq>=1 after injects"
        );
    } // drop stream — server-side connection task exits.

    // Second connection: send Resume from_seq=0, expect full replay.
    let mut stream2 = UnixStream::connect(&sock).await.expect("connect-2");
    let mut resume = Frame::new(Kind::Resume);
    resume.trace_id = Some("t-resume".into());
    resume.from_seq = Some(0);
    stream2
        .write_all(resume.to_ndjson_line().as_bytes())
        .await
        .unwrap();
    let _ = stream2.flush().await;

    let (rx, _tx) = stream2.split();
    let mut lines = BufReader::new(rx).lines();
    let mut replayed_seqs: Vec<u64> = Vec::new();
    // Pull a few lines with a tight overall budget.
    let collect_deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while tokio::time::Instant::now() < collect_deadline && replayed_seqs.len() < 8 {
        let remaining = collect_deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Ok(Some(line))) = timeout(remaining.max(Duration::from_millis(50)), lines.next_line()).await else { break };
        let Ok(f) = serde_json::from_str::<Frame>(&line) else { continue };
        if f.kind == Kind::Output {
            if let Some(s) = f.seq {
                replayed_seqs.push(s);
            }
        }
    }
    assert!(
        !replayed_seqs.is_empty(),
        "Resume produced no Output frames"
    );
    // Replayed seqs must be monotonically increasing (no out-of-order from disk).
    for w in replayed_seqs.windows(2) {
        assert!(w[0] < w[1], "replay seqs not monotonic: {:?}", replayed_seqs);
    }
    // All replayed seqs must be > from_seq (0 here).
    assert!(
        replayed_seqs.iter().all(|s| *s > 0),
        "replay leaked seq<=from_seq: {:?}",
        replayed_seqs
    );

    // Tear down via delete{force:true}.
    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    delete.force = Some(true);
    let _ = stream2
        .write_all(delete.to_ndjson_line().as_bytes())
        .await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn resume_with_high_from_seq_yields_no_replay() {
    let sid = unique_sid("highseq");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let log = log_path(&dir);
    let cfg = cfg(&sid, &["cat"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(wait_for_socket(&sock).await);

    // Produce some output.
    {
        let mut stream = UnixStream::connect(&sock).await.unwrap();
        let mut inject = Frame::new(Kind::Inject);
        inject.sid = Some(sid.clone());
        inject.trace_id = Some("t-1".into());
        inject.op_id = Some("op-1".into());
        inject.data = Some("gamma\n".into());
        let _ = stream.write_all(inject.to_ndjson_line().as_bytes()).await;
        let _ = stream.flush().await;
        let _ = wait_for_log_with_seq(&log, 1, 2000).await;
    }

    // Resume with absurdly high from_seq — replay should be empty.
    let mut stream2 = UnixStream::connect(&sock).await.unwrap();
    let mut resume = Frame::new(Kind::Resume);
    resume.from_seq = Some(u64::MAX / 2);
    let _ = stream2.write_all(resume.to_ndjson_line().as_bytes()).await;
    let _ = stream2.flush().await;

    let (rx, _tx) = stream2.split();
    let mut lines = BufReader::new(rx).lines();
    // Give the handler a moment; expect either no Output line OR only live frames
    // (no historical replay). In this test we don't issue any new injects after
    // Resume, so historical replay should be the only candidate — and it must be empty.
    let result = timeout(Duration::from_millis(400), lines.next_line()).await;
    if let Ok(Ok(Some(line))) = result {
        if let Ok(f) = serde_json::from_str::<Frame>(&line) {
            if f.kind == Kind::Output && f.seq.is_some() {
                panic!(
                    "expected no replay for high from_seq, got Output seq={:?}",
                    f.seq
                );
            }
        }
    }

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    delete.force = Some(true);
    let _ = stream2
        .write_all(delete.to_ndjson_line().as_bytes())
        .await;
    let _ = h.await;
}

#[tokio::test(flavor = "current_thread")]
async fn resume_before_any_output_is_ok() {
    let sid = unique_sid("empty");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    // `sleep` produces no PTY output before kill — log will be empty when Resume hits.
    let cfg = cfg(&sid, &["sleep", "5"]);
    let h = tokio::spawn(async move { run(cfg).await });
    assert!(wait_for_socket(&sock).await);

    let mut stream = UnixStream::connect(&sock).await.unwrap();
    let mut resume = Frame::new(Kind::Resume);
    resume.from_seq = Some(0);
    let _ = stream.write_all(resume.to_ndjson_line().as_bytes()).await;
    let _ = stream.flush().await;
    // Should NOT error / disconnect. Verify by sending a ping next and getting pong.
    let mut ping = Frame::new(Kind::Ping);
    ping.trace_id = Some("t-ping".into());
    let _ = stream.write_all(ping.to_ndjson_line().as_bytes()).await;
    let _ = stream.flush().await;
    let (rx, _tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();
    let pong_seen = loop {
        let r = timeout(Duration::from_millis(800), lines.next_line()).await;
        let Ok(Ok(Some(l))) = r else { break false };
        if let Ok(f) = serde_json::from_str::<Frame>(&l) {
            if f.kind == Kind::Pong && f.trace_id.as_deref() == Some("t-ping") {
                break true;
            }
        }
    };
    assert!(pong_seen, "ping/pong handshake broken after empty Resume");

    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.clone());
    delete.trace_id = Some("t-del".into());
    delete.force = Some(true);
    let _ = stream.write_all(delete.to_ndjson_line().as_bytes()).await;
    let _ = h.await;
}
