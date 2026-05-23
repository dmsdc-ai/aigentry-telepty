//! §8.A1 Normal termination contract test (C3 spec §8.A1).
//!
//! Child exits naturally (code 0). Expected: manifest unlinked (A8); log.jsonl
//! `shutdown_drain` with `exit_reason: "normal"`, `exit_code: 0`. Supervisor
//! exits within bounded time (spec says < 2000 ms; bounded at 3 s here for CI
//! headroom).

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use telepty_supervisor_core::audit::log_path;
use telepty_supervisor_core::ipc::socket_path_for;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{manifest_path, session_dir, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};
use telepty_supervisor_core::wire::{ExitReasonWire, Frame, Kind};

fn unique_sid(label: &str) -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("a1-test-{}-{}-{}", label, pid, nanos)
}

fn cfg(sid: &str, argv: &[&str]) -> SupervisorConfig {
    SupervisorConfig {
        sid: sid.to_string(),
        cwd: None,
        argv: argv.iter().map(|s| OsString::from(*s)).collect(),
        kill_gate: KillGateConfig::default(),
        kill_timeouts: KillTimeouts::default(),
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

#[tokio::test(flavor = "current_thread")]
async fn child_exits_zero_yields_normal_unlinked_log_shutdown_drain() {
    let sid = unique_sid("normal-zero");
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let mp = manifest_path(&sid).unwrap();
    let log = log_path(&dir);
    // `true` exits 0 immediately — purest §8.A1 fixture.
    let cfg = cfg(&sid, &["true"]);
    let h = tokio::spawn(async move { run(cfg).await });

    // Sleep enough for the supervisor to spawn + child to exit + finalize.
    // Don't probe socket; child may exit before we observe the socket file.
    let outcome = tokio::time::timeout(Duration::from_secs(3), h)
        .await
        .expect("supervisor did not exit within 3s for §8.A1 fixture")
        .expect("join error")
        .expect("run error");

    assert!(
        !mp.exists(),
        "§8.A1: manifest must be unlinked on Normal exit; still at {}",
        mp.display()
    );
    assert!(!sock.exists(), "§8.A1: socket must be unlinked on Normal exit");
    assert!(log.exists(), "§8.A1: log.jsonl must persist as audit artifact");

    let contents = std::fs::read_to_string(&log).expect("read log.jsonl");
    let drains: Vec<Frame> = contents
        .lines()
        .filter_map(|l| serde_json::from_str::<Frame>(l).ok())
        .filter(|f| f.kind == Kind::ShutdownDrain)
        .collect();
    assert_eq!(
        drains.len(),
        1,
        "§8.A1: expected exactly 1 shutdown_drain entry, got {}",
        drains.len()
    );
    let d = &drains[0];
    assert_eq!(d.exit_reason, Some(ExitReasonWire::Normal), "§8.A1: exit_reason must be normal");
    assert_eq!(d.exit_code, Some(0), "§8.A1: exit_code must be 0");
    assert_eq!(d.escalated, Some(false), "§8.A1: no escalation on Normal exit");
    assert_eq!(outcome.exit_code(), 0);
    let _ = wait_for_socket; // suppress warning if not used after refactor
}

#[tokio::test(flavor = "current_thread")]
async fn child_exits_nonzero_yields_normal_with_propagated_code() {
    // §8.A1 corollary: exit code is propagated even when nonzero — Normal exit
    // reason still applies (it's the exit MECHANISM, not the exit CODE, that
    // distinguishes Normal from Signaled/Killed/Crashed).
    let sid = unique_sid("normal-nonzero");
    let dir = session_dir(&sid).unwrap();
    let mp = manifest_path(&sid).unwrap();
    let log = log_path(&dir);
    let cfg = cfg(&sid, &["sh", "-c", "exit 7"]);
    let h = tokio::spawn(async move { run(cfg).await });

    let outcome = tokio::time::timeout(Duration::from_secs(3), h)
        .await
        .expect("supervisor did not exit within 3s")
        .expect("join error")
        .expect("run error");

    assert!(!mp.exists(), "manifest must be unlinked on Normal exit (even nonzero code)");
    let contents = std::fs::read_to_string(&log).expect("read log.jsonl");
    let drain = contents
        .lines()
        .filter_map(|l| serde_json::from_str::<Frame>(l).ok())
        .rev()
        .find(|f| f.kind == Kind::ShutdownDrain)
        .expect("shutdown_drain entry required");
    assert_eq!(drain.exit_reason, Some(ExitReasonWire::Normal));
    assert_eq!(drain.exit_code, Some(7));
    assert_eq!(outcome.exit_code(), 7);
}
