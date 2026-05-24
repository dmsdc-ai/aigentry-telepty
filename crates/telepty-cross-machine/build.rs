use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn git_hash() -> String {
    command_stdout("git", &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string())
}

fn git_dirty() -> bool {
    let worktree_dirty = Command::new("git")
        .args(["diff", "--quiet", "--ignore-submodules", "--"])
        .status()
        .map(|status| !status.success())
        .unwrap_or(false);
    let index_dirty = Command::new("git")
        .args(["diff", "--cached", "--quiet", "--ignore-submodules", "--"])
        .status()
        .map(|status| !status.success())
        .unwrap_or(false);
    worktree_dirty || index_dirty
}

fn build_timestamp() -> String {
    command_stdout("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]).unwrap_or_else(|| {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        format!("unix:{secs}")
    })
}

fn main() {
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!(
        "cargo:rustc-env=TELEPTY_CROSS_MACHINE_GIT_HASH={}",
        git_hash()
    );
    println!(
        "cargo:rustc-env=TELEPTY_CROSS_MACHINE_GIT_DIRTY={}",
        git_dirty()
    );
    println!(
        "cargo:rustc-env=TELEPTY_CROSS_MACHINE_BUILD_TIMESTAMP={}",
        build_timestamp()
    );
}
