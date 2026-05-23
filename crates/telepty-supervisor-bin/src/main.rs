//! Phase 1 sidecar supervisor binary.
//!
//! Usage: `telepty-supervisor-bin [--sid <s>] [--cwd <p>] -- <program> [args...]`
//! M1 ships spawn+observe; M2 layers on graceful + forced kill triggered by
//! the supervisor's own SIGTERM/SIGINT, manifest atomic write under
//! `~/.telepty/sessions/<sid>/`, and A8 finalize (unlink clean / tombstone
//! abnormal).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{anyhow, Result};
use clap::Parser;
use telepty_supervisor_core::kill_gate::KillTimeouts;
use telepty_supervisor_core::manifest::{scan_sessions, KillGateConfig};
use telepty_supervisor_core::supervisor::{run, SupervisorConfig};

#[derive(Parser, Debug)]
#[command(
    name = "telepty-supervisor-bin",
    about = "Phase 1 sidecar supervisor — spawn+observe+kill_gate (default) or --list",
    trailing_var_arg = true
)]
struct Args {
    /// A7: scan ~/.telepty/sessions/*/manifest.json and emit a JSON array of
    /// supervisor-managed sessions, then exit. Mutually exclusive with run mode.
    /// Output shape: bare JSON array of `Manifest`. This is the **supervisor-
    /// owned** view; the legacy `telepty list --json` daemon view is a
    /// superset that P3 cli refactor will reconcile (per dispatch §6.1).
    #[arg(long)]
    list: bool,
    #[arg(long, default_value = "demo")]
    sid: String,
    #[arg(long)]
    cwd: Option<PathBuf>,
    /// argv to wrap. Required unless --list is set.
    #[arg(num_args = 0.., allow_hyphen_values = true)]
    argv: Vec<OsString>,
}

fn main() -> ExitCode {
    init_tracing();
    let args = Args::parse();
    match drive(args) {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(e) => {
            tracing::error!(error = ?e, "supervisor exited with error");
            ExitCode::from(1)
        }
    }
}

fn drive(args: Args) -> Result<i32> {
    if args.list {
        return drive_list();
    }
    if args.argv.is_empty() {
        return Err(anyhow!(
            "no argv supplied; pass a command to wrap or use --list"
        ));
    }
    let cfg = SupervisorConfig {
        sid: args.sid,
        cwd: args.cwd,
        argv: args.argv,
        kill_gate: KillGateConfig::default(),
        kill_timeouts: KillTimeouts::default(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let outcome = runtime.block_on(run(cfg))?;
    Ok(outcome.exit_code())
}

fn drive_list() -> Result<i32> {
    let sessions = scan_sessions()?;
    // Bare JSON array per existing `telepty list --json` style. Pretty for
    // operator readability; downstream consumers can pipe through `jq`.
    let json = serde_json::to_string_pretty(&sessions)?;
    println!("{}", json);
    Ok(0)
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
