#!/usr/bin/env bash
# #737 — one-shot reproduction driver. Evidence lands in $OUTDIR.
#
# Touches NOTHING of the operator's: production daemon (3848), the `orchestrator`
# session, the real ~/.codex (auth.json is copied out, never written back), or the
# default tmux server (this uses its own socket, -L c737). `brew` is stubbed on PATH,
# so the modal's "Update now" default is RECORDED, never executed.
#
#   ./scratchpad/repro-737.sh          # full run (~3 min, spawns real codex)
#   ./scratchpad/repro-737.sh quick    # RED test + daemon byte capture only (~90s)
#
# Requires: tmux, repo node_modules, codex 0.144.1 at /opt/homebrew/bin/codex.

set -uo pipefail
cd "$(dirname "$0")/.."

OUTDIR=${OUTDIR:-/tmp/c737-work}
CODEX=${CODEX:-/opt/homebrew/bin/codex}
MODE=${1:-full}
mkdir -p "$OUTDIR"

# Requiring daemon.js leaves persisted-session poll timers armed, so a runner never exits
# on its own (known sandbox quirk). Hard-kill after the results are printed.
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

echo "######## 1. RED test — the contract #737 breaks ########"
run_capped 60 node --test test/codex-modal-first-inject-737.test.js 2>&1 \
  | grep -E "^(not ok|ok |# (pass|fail))"

echo
echo "######## 2. Daemon byte capture — does ANY inject path notice the modal? ########"
echo "# harness daemon on PORT=0 with an isolated HOME; production 3848 untouched."
# One daemon per variant: the daemon's timers keep the first process from exiting
# cleanly, so running them all in one process truncates the later ones.
for v in force gated plain control; do
  ONLY=$v run_capped 90 node scratchpad/e2e-737.js 2>&1 | grep -vE "^## e2e-737"
done

if [ "$MODE" = quick ]; then
  echo; echo "quick mode — skipping the real-codex matrix. Evidence: $OUTDIR"
  exit 0
fi

echo
echo "######## 3. Real codex 0.144.1 — tmux capture-pane as the VT ########"
command -v tmux >/dev/null || { echo "!! tmux required"; exit 1; }
[ -x "$CODEX" ] || { echo "!! codex not at $CODEX"; exit 1; }
echo "# codex: $("$CODEX" --version)"

# `messageLost` / `brewInvocations` / `codexExited` in the VERDICT are the #737 signature.
run() { local tag=$1; shift; env "$@" node scratchpad/repro-737-tmux.js "$tag" 2>&1 | grep -E "^## VERDICT"; }

echo "-- modal seeded (dismissed_version < latest_version), one row per inject path --"
run modal-force  MODAL=1 PATHSHAPE=force
run modal-plain  MODAL=1 PATHSHAPE=plain
run modal-gated  MODAL=1 PATHSHAPE=gated
echo "-- envelope ablation: raw body is eaten as keystrokes instead of firing option 1 --"
run modal-force-nowrap MODAL=1 PATHSHAPE=force WRAP=0
echo "-- control: same codex, dismissed_version == latest_version --"
run ctl-nomodal-force MODAL=0 PATHSHAPE=force

echo
echo "Evidence written to $OUTDIR (*.verdict.json, *.screens.txt, *.log, brew-invocations.log)."
