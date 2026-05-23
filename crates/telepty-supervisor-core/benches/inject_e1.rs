//! E1 local-inject latency bench (dispatch L52: cargo bench shows E1 < 1ms p50
//! on representative MacBook).
//!
//! Custom harness (no criterion — Constitution §17 / dispatch deps lock). Each
//! sample: write one inject NDJSON frame to the supervisor UDS, read until the
//! corresponding echo Output frame returns, record (now - start) as RTT. After
//! a warmup, compute p50/p90/p99/min/max over N samples and print.
//!
//! Exit code: 0 if p50 < 1.0 ms, else 1 (so CI can gate on the binary status).
//!
//! Run: `cargo bench --bench inject_e1`

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use telepty_supervisor_core::ipc::socket_path_for;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{session_dir, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};
use telepty_supervisor_core::wire::{Frame, Kind};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const WARMUP: usize = 100;
const SAMPLES: usize = 1000;
const P50_TARGET_MS: f64 = 1.0;

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio rt");
    let exit_code = rt.block_on(async { drive().await });
    std::process::exit(exit_code);
}

async fn drive() -> i32 {
    let sid = format!(
        "e1-bench-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let dir = session_dir(&sid).unwrap();
    let sock = socket_path_for(&dir);
    let cfg = SupervisorConfig {
        sid: sid.clone(),
        cwd: None,
        argv: vec![OsString::from("cat")],
        kill_gate: KillGateConfig::default(),
        kill_timeouts: KillTimeouts {
            graceful: Duration::from_millis(500),
            child_reap: Duration::from_millis(500),
        },
    };
    let h = tokio::spawn(async move { run(cfg).await });
    if !wait_for_socket(&sock).await {
        eprintln!("E1 bench: socket never appeared at {}", sock.display());
        return 1;
    }

    let stream = match UnixStream::connect(&sock).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("E1 bench: connect failed: {}", e);
            return 1;
        }
    };
    let (rx, mut tx) = stream.into_split();
    let mut lines = BufReader::new(rx).lines();

    // Warmup — drain output frames per inject, discard timing.
    for i in 0..WARMUP {
        let sentinel = format!("w{}", i);
        if !inject_and_wait(&mut tx, &mut lines, &sid, &sentinel, Duration::from_millis(200)).await
        {
            eprintln!("E1 bench: warmup iter {} timed out", i);
            cleanup(&mut tx, &sid).await;
            let _ = h.await;
            return 1;
        }
    }

    // Measurement — collect RTT samples.
    let mut samples_us: Vec<u128> = Vec::with_capacity(SAMPLES);
    for i in 0..SAMPLES {
        let sentinel = format!("m{}", i);
        let t0 = Instant::now();
        if !inject_and_wait(&mut tx, &mut lines, &sid, &sentinel, Duration::from_millis(200)).await
        {
            eprintln!("E1 bench: sample {} timed out", i);
            cleanup(&mut tx, &sid).await;
            let _ = h.await;
            return 1;
        }
        samples_us.push(t0.elapsed().as_micros());
    }

    cleanup(&mut tx, &sid).await;
    let _ = h.await;

    samples_us.sort_unstable();
    let p50 = pct(&samples_us, 0.50) as f64 / 1000.0;
    let p90 = pct(&samples_us, 0.90) as f64 / 1000.0;
    let p99 = pct(&samples_us, 0.99) as f64 / 1000.0;
    let min = *samples_us.first().unwrap() as f64 / 1000.0;
    let max = *samples_us.last().unwrap() as f64 / 1000.0;
    let mean = samples_us.iter().sum::<u128>() as f64 / samples_us.len() as f64 / 1000.0;

    let platform = bench_platform();
    println!("E1 local-inject latency ({} samples after {} warmup)", SAMPLES, WARMUP);
    println!("  platform: {}", platform);
    println!("  p50: {:.3} ms (target < {:.1} ms)", p50, P50_TARGET_MS);
    println!("  p90: {:.3} ms", p90);
    println!("  p99: {:.3} ms", p99);
    println!("  min: {:.3} ms  max: {:.3} ms  mean: {:.3} ms", min, max, mean);

    if p50 < P50_TARGET_MS {
        println!("E1-result: PASS");
        0
    } else {
        println!("E1-result: FAIL (p50 {:.3} ms ≥ target {:.1} ms)", p50, P50_TARGET_MS);
        1
    }
}

async fn inject_and_wait(
    tx: &mut tokio::net::unix::OwnedWriteHalf,
    lines: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    sid: &str,
    sentinel: &str,
    deadline: Duration,
) -> bool {
    let mut inject = Frame::new(Kind::Inject);
    inject.sid = Some(sid.to_string());
    inject.trace_id = Some(format!("t-{}", sentinel));
    inject.op_id = Some(format!("op-{}", sentinel));
    inject.data = Some(format!("{}\n", sentinel));
    if tx.write_all(inject.to_ndjson_line().as_bytes()).await.is_err() {
        return false;
    }
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        let remaining = until.saturating_duration_since(Instant::now());
        let r = tokio::time::timeout(remaining, lines.next_line()).await;
        let Ok(Ok(Some(line))) = r else { return false };
        let Ok(f): Result<Frame, _> = serde_json::from_str(&line) else { continue };
        if f.kind == Kind::Output {
            if let Some(data) = f.data.as_deref() {
                if data.contains(sentinel) {
                    return true;
                }
            }
        }
    }
    false
}

async fn cleanup(tx: &mut tokio::net::unix::OwnedWriteHalf, sid: &str) {
    let mut delete = Frame::new(Kind::Delete);
    delete.sid = Some(sid.to_string());
    delete.trace_id = Some("t-del".into());
    delete.force = Some(true);
    let _ = tx.write_all(delete.to_ndjson_line().as_bytes()).await;
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

fn pct(sorted: &[u128], q: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[idx]
}

fn bench_platform() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    let mut parts = vec![format!("{}/{}", os, arch)];
    if os == "macos" {
        if let Ok(out) = Command::new("sysctl").arg("-n").arg("hw.model").output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
        if let Ok(out) = Command::new("sysctl")
            .arg("-n")
            .arg("machdep.cpu.brand_string")
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
    }
    parts.join(" / ")
}
