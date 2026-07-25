#!/usr/bin/env bash
# #730 — one-shot reproduction driver. Runs every probe in order and leaves the
# evidence under $OUTDIR. Nothing here touches the production daemon (3848), the
# `orchestrator` session, or the user's real ~/.codex.
#
#   ./scratchpad/repro-730.sh            # full run (~6 min, spawns real codex)
#   ./scratchpad/repro-730.sh quick      # RED test + e2e byte capture only (~30s)
#
# Requires: tmux, node-pty (repo node_modules), codex 0.144.1 at /opt/homebrew/bin/codex.

set -uo pipefail
cd "$(dirname "$0")/.."

OUTDIR=${OUTDIR:-/tmp/c730-work}
CODEX=${CODEX:-/opt/homebrew/bin/codex}
MODE=${1:-full}
mkdir -p "$OUTDIR"

# Isolated CODEX_HOME. The real ~/.codex has dismissed_version=0.137.0, so a fresh
# codex there opens a blocking "Update available … Press enter to continue" modal that
# eats the first inject — a confound, and a finding in its own right (see EVIDENCE-730.md).
setup_codex_home() {
  local h="$OUTDIR/codex-home"
  mkdir -p "$h"
  cp ~/.codex/auth.json "$h/auth.json" 2>/dev/null || { echo "!! no ~/.codex/auth.json — codex must be logged in"; exit 1; }
  printf '{"latest_version":"0.145.0","last_checked_at":"2126-01-01T00:00:00Z","dismissed_version":"0.145.0"}\n' > "$h/version.json"
  cat > "$h/config.toml" <<'EOF'
model = "gpt-5.5"
approval_policy = "never"
sandbox_mode = "read-only"

[projects."/tmp/c730-work"]
trust_level = "trusted"

[projects."/private/tmp/c730-work"]
trust_level = "trusted"
EOF
}

# Requiring daemon.js leaves persisted-session poll timers armed, so the runner never
# exits on its own (known sandbox quirk). Hard-kill after the results are printed.
run_capped() {
  local secs=$1; shift
  node -e '
    const {spawn}=require("child_process");
    const [secs,...cmd]=process.argv.slice(1);
    const c=spawn(cmd[0],cmd.slice(1),{stdio:"inherit"});
    const t=setTimeout(()=>c.kill("SIGKILL"),Number(secs)*1000);
    c.on("exit",()=>{clearTimeout(t);process.exit(0)});
  ' "$secs" "$@"
}

echo "######## 1. RED test — the product invariants #730 breaks ########"
run_capped 30 node --test test/codex-submit-0144-730.test.js 2>&1 | grep -E "^(not ok|ok |# (pass|fail))"

echo
echo "######## 2. E2E byte capture — REAL telepty force-submit path ########"
echo "# harness daemon on PORT=0 with an isolated HOME; production 3848 untouched."
# Each variant boots its own daemon: the daemon's timers keep the first process from
# exiting cleanly, so running both in one process truncates the second.
ONLY=sees run_capped 60 node scratchpad/e2e-730.js 2>&1 | grep -vE "^\[variant\]"
ONLY=miss run_capped 60 node scratchpad/e2e-730.js 2>&1 | grep -vE "^\[variant\]"

if [ "$MODE" = quick ]; then
  echo; echo "quick mode — skipping the real-codex matrix. Evidence: $OUTDIR"
  exit 0
fi

echo
echo "######## 3. Real codex 0.144.1 matrix — tmux capture-pane as the VT ########"
command -v tmux >/dev/null || { echo "!! tmux required"; exit 1; }
[ -x "$CODEX" ] || { echo "!! codex not at $CODEX"; exit 1; }
echo "# codex: $("$CODEX" --version)"
setup_codex_home

# (envelope, body shape, text->CR gap) -> does the CR register as a submit?
# `parked` > 0 in the VERDICT means the body stayed in the composer: CR swallowed.
matrix() {
  local tag=$1 wrap=$2 gap=$3; shift 3
  WRAP=$wrap GAP_MS=$gap BUSY=0 "$@" node scratchpad/repro-730-tmux.js "$tag" 2>&1 | grep -E "^## VERDICT" | sed 's/,"results".*//'
}

echo "-- un-enveloped multi-line body, sweeping the text->CR gap --"
for g in 10 50 80 100 120 150 300 600; do matrix "m-nowrap-ml-g$g" 0 "$g" env BODY_LINES=8; done
echo "-- controls --"
matrix "m-nowrap-1line-g10" 0 10 env BODY_CHARS=600   # single line, same 10ms gap
matrix "m-wrap-ml-g10"      1 10 env BODY_LINES=8     # #716 envelope, same 10ms gap

echo
echo "Evidence written to $OUTDIR (*.verdict.json, *.screens.txt, *.log)."
