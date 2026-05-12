//! Phase 1 sidecar supervisor — M1 entry point.
//!
//! M1 binary contract (per dispatch task):
//!   `telepty-supervisor-bin [--sid <s>] [--cwd <p>] -- <program> [args...]`
//!
//! Plan §4.1's command shape (`--sid demo --cwd /tmp -- echo hello`) and the
//! dispatch's simpler shape (`-- echo hello`) both work; --sid/--cwd are
//! accepted but unused beyond `cwd` propagation until M2/M3 wire in manifest
//! + kill-gate.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::Parser;
use telepty_supervisor_core::supervisor::spawn_observe;

#[derive(Parser, Debug)]
#[command(
    name = "telepty-supervisor-bin",
    about = "Phase 1 sidecar supervisor — M1 spawn+observe",
    trailing_var_arg = true
)]
struct Args {
    /// Session id (placeholder for M1 — used by M2+ manifest path).
    #[arg(long, default_value = "demo")]
    #[allow(dead_code)]
    sid: String,

    /// Child working directory; inherited from supervisor cwd if unset.
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Program + args. Use `--` before it if any flag-shaped tokens are in argv.
    #[arg(required = true, num_args = 1.., allow_hyphen_values = true)]
    argv: Vec<OsString>,
}

fn main() -> ExitCode {
    init_tracing();

    let args = Args::parse();
    match run(args) {
        Ok(code) => {
            // exit_code() returns u32 from portable-pty; clamp to u8 for ExitCode.
            let code_u8 = u8::try_from(code).unwrap_or(1);
            ExitCode::from(code_u8)
        }
        Err(e) => {
            tracing::error!(error = ?e, "supervisor exited with error");
            ExitCode::from(1)
        }
    }
}

fn run(args: Args) -> Result<i32> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let outcome = runtime.block_on(spawn_observe(&args.argv, args.cwd))?;
    tracing::info!(exit_status = ?outcome.exit_status, "child exited");
    Ok(outcome.exit_code())
}

fn init_tracing() {
    // Tracing → stderr so child PTY output on stdout stays clean for smoke
    // verification. RUST_LOG controls level (default warn).
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
