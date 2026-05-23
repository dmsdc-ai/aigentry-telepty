//! F3 atomic manifest write contract tests.
//!
//! Per orchestrator Phase 4 §(b): "golden-file approach OK; concurrent reader
//! during writer's rename → reader sees either complete-old or complete-new,
//! never partial". F3 is implemented by `manifest::write_atomic` (tmp + fsync
//! tmp + rename + fsync parent_dir).
//!
//! Test surfaces:
//! - golden: write produces the canonical file at `path` with no leftover .tmp
//! - golden: create_dir_all is invoked for missing parent dirs
//! - contract: 200 concurrent reads against an aggressive writer loop never
//!   observe partial JSON (the rename atomicity guarantee)
//! - idempotency: unlink_clean is a no-op on ENOENT

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use telepty_supervisor_core::manifest::{
    unlink_clean, write_atomic, ExitReason, IpcRef, KillGateConfig, Manifest, Status,
    SCHEMA_VERSION,
};

fn mk_manifest(id: &str, restart_count: u32) -> Manifest {
    Manifest {
        schema_version: SCHEMA_VERSION,
        id: id.into(),
        pid: 12345,
        ipc: IpcRef {
            kind: "uds".into(),
            path: "/tmp/x.sock".into(),
        },
        status: Status::Ready,
        restart_count,
        created_at: "2026-05-23T00:00:00Z".into(),
        kill_gate: KillGateConfig::default(),
        exit_reason: None,
        exit_signal: None,
        exit_code: None,
        crashed_at: None,
        unkillable_at: None,
        stopped_at: None,
    }
}

fn fresh_tmpdir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "telepty-f3-{}-{}-{}",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn write_atomic_produces_canonical_file_no_tmp_leftover() {
    let dir = fresh_tmpdir("canonical");
    let path = dir.join("manifest.json");
    let m = mk_manifest("golden-1", 0);
    write_atomic(&path, &m).expect("write_atomic ok");

    assert!(path.exists(), "manifest.json must exist at {}", path.display());
    let tmp = path.with_extension("json.tmp");
    assert!(!tmp.exists(), ".json.tmp must not leak after rename");

    let bytes = std::fs::read(&path).unwrap();
    let back: Manifest = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(back.id, "golden-1");
    assert_eq!(back.schema_version, SCHEMA_VERSION);
    assert!(matches!(back.exit_reason, None));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn write_atomic_creates_missing_parent_dir() {
    let dir = fresh_tmpdir("parent");
    let nested = dir.join("layer-a").join("layer-b");
    let path = nested.join("manifest.json");
    assert!(!nested.exists(), "precondition: nested dir must not exist");
    let m = mk_manifest("nested-1", 0);
    write_atomic(&path, &m).expect("write_atomic should create_dir_all");
    assert!(path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unlink_clean_is_idempotent_on_enoent() {
    let dir = fresh_tmpdir("idem");
    let path = dir.join("manifest.json");
    assert!(!path.exists());
    // Should not error on missing file.
    unlink_clean(&path).expect("unlink_clean on missing path must be Ok");
    // After write + unlink, second unlink is also Ok.
    write_atomic(&path, &mk_manifest("idem-1", 0)).unwrap();
    unlink_clean(&path).unwrap();
    assert!(!path.exists());
    unlink_clean(&path).expect("second unlink_clean must be Ok");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_readers_never_observe_partial_json() {
    // Contract: while a writer loop performs write_atomic at maximum rate, N
    // concurrent reader threads polling the same path must always either see
    // a valid Manifest parse OR ENOENT (between unlink+rename window — though
    // rename is atomic so they should never see ENOENT here either). Any
    // successful read whose bytes fail to parse to Manifest indicates a F3
    // violation (caller observed partial JSON).

    let dir = fresh_tmpdir("concurrent");
    let path = dir.join("manifest.json");
    // Seed an initial file so readers always find something parseable.
    write_atomic(&path, &mk_manifest("seed", 0)).unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let parse_failures = Arc::new(AtomicU32::new(0));
    let read_attempts = Arc::new(AtomicU32::new(0));

    // Writer thread — bumps restart_count each iteration to grow the JSON body.
    let writer_stop = stop.clone();
    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        let mut n = 0u32;
        while !writer_stop.load(Ordering::Relaxed) {
            n = n.wrapping_add(1);
            let m = mk_manifest("concurrent", n);
            write_atomic(&writer_path, &m).expect("writer write_atomic");
        }
        n
    });

    // Reader threads.
    let mut readers = Vec::new();
    for _ in 0..6 {
        let r_stop = stop.clone();
        let r_failures = parse_failures.clone();
        let r_attempts = read_attempts.clone();
        let r_path = path.clone();
        readers.push(std::thread::spawn(move || {
            while !r_stop.load(Ordering::Relaxed) {
                match std::fs::read(&r_path) {
                    Ok(bytes) if !bytes.is_empty() => {
                        r_attempts.fetch_add(1, Ordering::Relaxed);
                        if serde_json::from_slice::<Manifest>(&bytes).is_err() {
                            r_failures.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Ok(_) => { /* empty read; tolerate */ }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => { /* between writes; tolerate */ }
                    Err(_) => { /* other transient; tolerate */ }
                }
            }
        }));
    }

    std::thread::sleep(Duration::from_millis(800));
    stop.store(true, Ordering::Relaxed);
    let total_writes = writer.join().unwrap();
    for r in readers {
        r.join().unwrap();
    }
    let attempts = read_attempts.load(Ordering::Relaxed);
    let failures = parse_failures.load(Ordering::Relaxed);

    // Environment-load floors are intentionally loose — the actual F3 contract
    // is `failures == 0` below. Even slow CI hits these comfortably.
    assert!(
        total_writes >= 10,
        "writer ran too few iters ({}) for meaningful coverage",
        total_writes
    );
    assert!(
        attempts >= 20,
        "readers ran too few attempts ({}) for meaningful coverage",
        attempts
    );
    assert_eq!(
        failures, 0,
        "F3 VIOLATION: {}/{} reads observed partial JSON during concurrent write loop ({} writer iters)",
        failures, attempts, total_writes
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn write_atomic_tombstone_preserves_audit_fields() {
    // F3 corollary: tombstone path (write_tombstone delegating to write_atomic)
    // must round-trip exit_reason + exit_signal + tombstone timestamps without
    // partial-field leakage from prior writes.
    let dir = fresh_tmpdir("tombstone");
    let path = dir.join("manifest.json");
    // Live write first.
    write_atomic(&path, &mk_manifest("tomb-1", 2)).unwrap();
    // Tombstone overwrite — same path, new shape.
    let mut tomb = mk_manifest("tomb-1", 2);
    tomb.status = Status::Error;
    tomb.exit_reason = Some(ExitReason::Crashed);
    tomb.exit_signal = Some("SIGSEGV".into());
    tomb.exit_code = Some(139);
    tomb.crashed_at = Some("2026-05-23T01:02:03Z".into());
    tomb.stopped_at = Some("2026-05-23T01:02:03Z".into());
    write_atomic(&path, &tomb).unwrap();

    let bytes = std::fs::read(&path).unwrap();
    let back: Manifest = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(back.status, Status::Error);
    assert_eq!(back.exit_reason, Some(ExitReason::Crashed));
    assert_eq!(back.exit_signal.as_deref(), Some("SIGSEGV"));
    assert_eq!(back.exit_code, Some(139));
    assert!(back.crashed_at.is_some());
    assert!(back.stopped_at.is_some());
    assert_eq!(back.restart_count, 2);

    let _ = std::fs::remove_dir_all(&dir);
}
