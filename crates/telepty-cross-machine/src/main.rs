use clap::Parser;
mod subcommands;

#[derive(Debug, Parser)]
#[command(
    name = "telepty-cross-machine",
    about = "Standalone HTTP peer operations for telepty",
    disable_version_flag = true
)]
struct Cli {
    #[command(subcommand)]
    command: subcommands::Command,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if wants_version() {
        println!("{}", version_string());
        return;
    }

    let cli = Cli::parse();
    if let Err(err) = cli.command.run().await {
        eprintln!("{err}");
        std::process::exit(err.exit_code());
    }
}

fn wants_version() -> bool {
    let mut args = std::env::args_os();
    let _ = args.next();
    matches!(args.next().as_deref(), Some(value) if value == "--version" || value == "-V")
        && args.next().is_none()
}

fn version_string() -> String {
    let dirty = match option_env!("TELEPTY_CROSS_MACHINE_GIT_DIRTY") {
        Some("true") => ", dirty",
        _ => "",
    };
    format!(
        "telepty-cross-machine {} ({}{dirty})",
        env!("CARGO_PKG_VERSION"),
        option_env!("TELEPTY_CROSS_MACHINE_GIT_HASH").unwrap_or("unknown")
    )
}
