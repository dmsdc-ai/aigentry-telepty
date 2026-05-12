#!/usr/bin/env bash
# F8 reproducible RSS measurement for the Phase 1 sidecar supervisor.
#
# Acceptance gate G9 / V1 ADR E3: each supervisor process RSS ≤ 15 MB (15360 KB).
# Methodology (Q-E hybrid r2):
# - Per-run namespace under ~/.telepty/sessions/rss-<run_id>-<i>/ (no global collisions).
# - Exact PID tracking (no `pgrep` heuristics — F8 r2 / codex L33).
# - Cleanup trap kills supervisors (TERM → KILL) and removes session dirs.
# - Authoritative metric: POSIX `ps -o rss=`. Linux additionally captures
#   `/proc/<pid>/status VmRSS` as a second source.
# - PSS via smaps deferred to Phase 4 measurement-gate spec.
#
# Usage:
#   scripts/measure-rss.sh [N=1] [DURATION_S=60]
# Emits a JSON report on stdout and exits 0 iff every supervisor's peak RSS
# is ≤ LIMIT_KB. Exit 1 = E3 fail (gate).
set -uo pipefail

N="${1:-1}"
DURATION_S="${2:-60}"
LIMIT_KB="${LIMIT_KB:-15360}"
BIN="${BIN:-./target/release/telepty-supervisor-bin}"

[[ -x "$BIN" ]] || { echo "{\"error\":\"missing $BIN — run cargo build --release\"}"; exit 2; }

RUN_ID="$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
SAMPLES_FILE="$(mktemp -t p1-rss-${RUN_ID}.XXXXXX)"
PIDS=()
SIDS=()

cleanup() {
    for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true; done
    sleep 0.5
    for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true; done
    for sid in "${SIDS[@]:-}"; do [[ -n "$sid" ]] && rm -rf "$HOME/.telepty/sessions/$sid"; done
    rm -f "$SAMPLES_FILE"
}
trap cleanup EXIT INT TERM

# Spawn N supervisors with deterministic idle child (`sleep 600`).
for i in $(seq 1 "$N"); do
    sid="rss-${RUN_ID}-${i}"
    SIDS+=("$sid")
    rm -rf "$HOME/.telepty/sessions/$sid"
    "$BIN" --sid "$sid" -- sleep 600 >/dev/null 2>&1 &
    PIDS+=($!)
done

# Warmup window for tokio + jemalloc steady state.
sleep 5

for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "{\"error\":\"supervisor pid $pid not running after warmup\",\"run_id\":\"$RUN_ID\"}"
        exit 1
    fi
done

UNAME="$(uname)"
SAMPLE_INTERVAL_S=5
END=$(( $(date +%s) + DURATION_S ))
while [[ $(date +%s) -lt $END ]]; do
    for pid in "${PIDS[@]}"; do
        rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
        [[ -z "$rss" ]] && rss=0
        printf '%s ps %s\n' "$pid" "$rss" >> "$SAMPLES_FILE"
        if [[ "$UNAME" == "Linux" && -r "/proc/$pid/status" ]]; then
            vm=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
            [[ -n "$vm" ]] && printf '%s proc %s\n' "$pid" "$vm" >> "$SAMPLES_FILE"
        fi
    done
    sleep "$SAMPLE_INTERVAL_S"
done

python3 - "$SAMPLES_FILE" "$RUN_ID" "$LIMIT_KB" "$N" "$DURATION_S" "${PIDS[@]}" <<'PY'
import sys, json
samples_file, run_id, limit_kb, n_str, dur, *pids = sys.argv[1:]
LIMIT_KB = int(limit_kb)
by_pid = {p: {"ps": [], "proc": []} for p in pids}
with open(samples_file) as f:
    for line in f:
        parts = line.split()
        if len(parts) != 3: continue
        pid, src, val = parts
        if pid in by_pid and src in by_pid[pid]:
            by_pid[pid][src].append(int(val))

def stats(samples):
    if not samples:
        return None
    s = sorted(samples)
    p50 = s[len(s) // 2]
    p99 = s[max(0, int(len(s) * 0.99) - 1)] if len(s) >= 100 else s[-1]
    return {"samples": len(s), "p50_kb": p50, "p99_kb": p99, "peak_kb": max(s)}

result = {
    "run_id": run_id,
    "limit_kb": LIMIT_KB,
    "n": int(n_str),
    "duration_s": int(dur),
    "uname": __import__("platform").system(),
    "supervisors": [],
}
all_pass = True
for pid in pids:
    ps_stats = stats(by_pid[pid]["ps"])
    proc_stats = stats(by_pid[pid]["proc"])
    if ps_stats is None:
        all_pass = False
        result["supervisors"].append({"pid": pid, "verdict": "FAIL_NO_SAMPLES"})
        continue
    verdict = "PASS" if ps_stats["peak_kb"] <= LIMIT_KB else "FAIL"
    if verdict == "FAIL": all_pass = False
    entry = {"pid": pid, "ps": ps_stats, "verdict": verdict}
    if proc_stats: entry["proc"] = proc_stats
    result["supervisors"].append(entry)
result["overall"] = "PASS" if all_pass else "FAIL"
print(json.dumps(result, indent=2))
sys.exit(0 if all_pass else 1)
PY
