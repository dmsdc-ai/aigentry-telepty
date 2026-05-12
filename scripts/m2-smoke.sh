#!/usr/bin/env bash
# M2 smoke harness — exercises kill_gate against the release binary.
# Manual gate per plan §4.2 / dispatch. Run after `cargo build --release`.
set -uo pipefail

BIN="${PWD}/target/release/telepty-supervisor-bin"
[[ -x "$BIN" ]] || { echo "missing $BIN — run: cargo build --release"; exit 2; }

MANIFEST_DIR="${HOME}/.telepty/sessions"
LOG_DIR=$(mktemp -d)
PASS=0
FAIL=0

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

emit() {
    local label="$1" verdict="$2" detail="${3:-}"
    if [[ "$verdict" == "pass" ]]; then
        printf '[PASS] %s  %s\n' "$label" "$detail"
        PASS=$((PASS+1))
    else
        printf '[FAIL] %s  %s\n' "$label" "$detail"
        FAIL=$((FAIL+1))
    fi
}

# Smoke 1: graceful happy path — child handles SIGTERM, prints BYE, exits 0.
smoke1() {
    local sid="m2-smoke-1"
    rm -rf "${MANIFEST_DIR:?}/${sid}"
    local log="${LOG_DIR}/smoke1.log"
    "$BIN" --sid "$sid" -- bash -c 'trap "echo BYE; exit 0" TERM; sleep 5' >"$log" 2>&1 &
    local pid=$!
    sleep 0.6  # supervisor startup (build cold-cache, signal handler install) + slack
    kill -TERM "$pid"
    wait "$pid"
    local rc=$?
    local has_bye=0
    grep -q "BYE" "$log" && has_bye=1
    local unlinked=0
    [[ ! -e "${MANIFEST_DIR}/${sid}/manifest.json" ]] && unlinked=1
    if [[ "$rc" -eq 0 && "$has_bye" -eq 1 && "$unlinked" -eq 1 ]]; then
        emit "smoke1-graceful" pass "exit=$rc BYE-seen manifest-unlinked"
    else
        emit "smoke1-graceful" fail "exit=$rc BYE=$has_bye unlinked=$unlinked log=$log"
    fi
}

# Smoke 2: forced kill — child ignores SIGTERM, supervisor escalates to SIGKILL
# at GRACEFUL_GRACE_MS. Per SPEC-C3-r1 §6.3.1, exit_reason=killed is CLEAN so
# manifest is unlinked (tombstone reserved for crashed/unkillable only).
smoke2() {
    local sid="m2-smoke-2"
    rm -rf "${MANIFEST_DIR:?}/${sid}"
    local log="${LOG_DIR}/smoke2.log"
    local start
    start=$(now_ms)
    "$BIN" --sid "$sid" -- bash -c 'trap "" TERM; sleep 30' >"$log" 2>&1 &
    local pid=$!
    sleep 0.6  # supervisor startup (build cold-cache, signal handler install) + slack
    kill -TERM "$pid"
    wait "$pid"
    local rc=$?
    local elapsed=$(( $(now_ms) - start ))
    local unlinked=0
    [[ ! -e "${MANIFEST_DIR}/${sid}/manifest.json" ]] && unlinked=1
    # Expected ~400 (warmup) + 3000 (grace) + ~100 (reap) ≈ 3500 ms; allow ≤ 5000.
    if [[ "$rc" -eq 0 && "$unlinked" -eq 1 && "$elapsed" -lt 5000 && "$elapsed" -ge 3000 ]]; then
        emit "smoke2-forced" pass "exit=$rc elapsed=${elapsed}ms manifest-unlinked"
    else
        emit "smoke2-forced" fail "exit=$rc elapsed=${elapsed}ms unlinked=$unlinked log=$log"
    fi
}

# Smoke 3: MockChild unit (cargo test — kill_gate + manifest crates).
smoke3() {
    local out
    out=$(cargo test --lib --quiet --package telepty-supervisor-core 2>&1)
    local passed
    passed=$(echo "$out" | grep -oE "test result: ok\. [0-9]+ passed" | grep -oE "[0-9]+" | head -1)
    if [[ -n "$passed" && "$passed" -ge 4 ]]; then
        emit "smoke3-mockchild" pass "cargo test ${passed}/${passed} (manifest + kill_gate + wire + ipc)"
    else
        emit "smoke3-mockchild" fail "$(echo "$out" | tail -5 | tr '\n' '|')"
    fi
}

# Smoke 4: reap correctness — direct child only.
# bash forks a backgrounded sleep then exits 0. Per SPEC-C3-r1 §4.1.2 the
# supervisor reaps direct child only; it must NOT wait for grandchildren.
# (The orphaned sleep is reparented to launchd/init — we pkill it for hygiene.)
smoke4() {
    local sid="m2-smoke-4"
    rm -rf "${MANIFEST_DIR:?}/${sid}"
    local log="${LOG_DIR}/smoke4.log"
    local start
    start=$(now_ms)
    "$BIN" --sid "$sid" -- bash -c 'setsid sleep 30 >/dev/null 2>&1 & exit 0' >"$log" 2>&1
    local rc=$?
    local elapsed=$(( $(now_ms) - start ))
    local unlinked=0
    [[ ! -e "${MANIFEST_DIR}/${sid}/manifest.json" ]] && unlinked=1
    # Direct child exits immediately → supervisor reaps + finalizes within ~1s.
    if [[ "$rc" -eq 0 && "$elapsed" -lt 2500 && "$unlinked" -eq 1 ]]; then
        emit "smoke4-reap" pass "exit=$rc elapsed=${elapsed}ms direct-child-only"
    else
        emit "smoke4-reap" fail "exit=$rc elapsed=${elapsed}ms unlinked=$unlinked log=$log"
    fi
    pkill -f "^sleep 30$" 2>/dev/null || true
}

# Smoke 5: PTY Order A — drain converges; supervisor exits clean after child
# writes-then-sleeps-then-writes-then-exits. Verifies master-close-after-reap
# ordering doesn't truncate output or deadlock.
smoke5() {
    local sid="m2-smoke-5"
    rm -rf "${MANIFEST_DIR:?}/${sid}"
    local log="${LOG_DIR}/smoke5.log"
    "$BIN" --sid "$sid" -- bash -c 'echo PRE; sleep 0.2; echo POST' >"$log" 2>&1
    local rc=$?
    local unlinked=0
    [[ ! -e "${MANIFEST_DIR}/${sid}/manifest.json" ]] && unlinked=1
    if [[ "$rc" -eq 0 && "$unlinked" -eq 1 ]] && grep -q PRE "$log" && grep -q POST "$log"; then
        emit "smoke5-pty-order" pass "exit=$rc PRE+POST captured manifest-unlinked"
    else
        emit "smoke5-pty-order" fail "exit=$rc unlinked=$unlinked log=$log"
    fi
}

smoke1
smoke2
smoke3
smoke4
smoke5

printf '\nM2 smoke summary: %d pass / %d fail (logs: %s)\n' "$PASS" "$FAIL" "$LOG_DIR"
[[ "$FAIL" -eq 0 ]] || exit 1
