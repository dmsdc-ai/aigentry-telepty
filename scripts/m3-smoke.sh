#!/usr/bin/env bash
# M3 smoke harness — exercises wire + IPC against the release binary.
# Manual gate per plan §4 M3 / dispatch. Run after `cargo build --release`.
#
# Uses a small embedded Python UDS client because BSD nc on macOS lacks the -q
# linger flag.
set -uo pipefail

BIN="${PWD}/target/release/telepty-supervisor-bin"
[[ -x "$BIN" ]] || { echo "missing $BIN — run: cargo build --release"; exit 2; }

MANIFEST_DIR="${HOME}/.telepty/sessions"
LOG_DIR=$(mktemp -d)
PASS=0
FAIL=0

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

# udsx <sock> <line1>[;<line2>;...] <read_seconds>
# Writes each ;-separated line followed by \n, then reads from the socket for
# <read_seconds> and prints whatever it received.
udsx() {
    local sock="$1" lines="$2" read_s="$3"
    python3 - "$sock" "$lines" "$read_s" <<'PY'
import socket, sys, time
sock_path, lines, read_s = sys.argv[1], sys.argv[2], float(sys.argv[3])
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(read_s + 1.0)
s.connect(sock_path)
for line in lines.split(";;;"):
    if not line: continue
    s.sendall((line + "\n").encode())
s.shutdown(socket.SHUT_WR)
buf = b""
deadline = time.time() + read_s
s.settimeout(0.2)
while time.time() < deadline:
    try:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
    except socket.timeout:
        if buf: break
        continue
    except OSError:
        break
sys.stdout.buffer.write(buf)
PY
}

launch() {
    local sid="$1"; shift
    rm -rf "${MANIFEST_DIR:?}/${sid}"
    "$BIN" --sid "$sid" -- "$@" >"${LOG_DIR}/${sid}.stdout" 2>"${LOG_DIR}/${sid}.stderr" &
    local pid=$!
    local sock="${MANIFEST_DIR}/${sid}/supervisor.sock"
    for _ in $(seq 1 40); do
        [[ -S "$sock" ]] && { echo "$pid $sock"; return 0; }
        sleep 0.05
    done
    echo "$pid $sock"
    return 1
}

teardown() {
    local sid="$1" pid="$2"
    local sock="${MANIFEST_DIR}/${sid}/supervisor.sock"
    if [[ -S "$sock" ]]; then
        udsx "$sock" "{\"v\":1,\"kind\":\"delete\",\"sid\":\"${sid}\",\"trace_id\":\"td\",\"force\":true}" 0.3 >/dev/null 2>&1 || true
    fi
    wait "$pid" 2>/dev/null || true
}

smoke1() {
    local sid="m3-ping" sock pid line
    read -r pid sock < <(launch "$sid" bash -c 'sleep 30')
    line=$(udsx "$sock" '{"v":1,"kind":"ping","trace_id":"t-ping"}' 0.5)
    if echo "$line" | grep -q '"kind":"pong"' && echo "$line" | grep -q '"trace_id":"t-ping"'; then
        emit "smoke1-ping-pong" pass "got pong w/ trace_id"
    else
        emit "smoke1-ping-pong" fail "line=$(echo "$line" | tr '\n' '|')"
    fi
    teardown "$sid" "$pid"
}

smoke2() {
    local sid="m3-inject" sock pid out
    read -r pid sock < <(launch "$sid" bash -i)
    out=$(udsx "$sock" \
        "{\"v\":1,\"kind\":\"inject\",\"sid\":\"${sid}\",\"trace_id\":\"t1\",\"data\":\"echo HELLO-FROM-INJECT\\n\"}" \
        1.0)
    if echo "$out" | grep -q "HELLO-FROM-INJECT"; then
        emit "smoke2-inject-output" pass "output frame echoed injected line"
    else
        emit "smoke2-inject-output" fail "out=$(echo "$out" | tr '\n' '|' | head -c 240)"
    fi
    teardown "$sid" "$pid"
}

smoke3() {
    local sid="m3-notrace" sock pid line
    read -r pid sock < <(launch "$sid" bash -c 'sleep 30')
    line=$(udsx "$sock" "{\"v\":1,\"kind\":\"inject\",\"sid\":\"${sid}\",\"data\":\"hi\\n\"}" 0.5)
    if echo "$line" | grep -q '"code":"ERR_BAD_FRAME"' && echo "$line" | grep -q "inject_missing_trace_id"; then
        emit "smoke3-no-trace-id" pass "ERR_BAD_FRAME inject_missing_trace_id"
    else
        emit "smoke3-no-trace-id" fail "line=$(echo "$line" | tr '\n' '|')"
    fi
    teardown "$sid" "$pid"
}

smoke4() {
    local sid="m3-dup" sock pid combined
    read -r pid sock < <(launch "$sid" bash -c 'sleep 30')
    local one="{\"v\":1,\"kind\":\"inject\",\"sid\":\"${sid}\",\"trace_id\":\"t1\",\"op_id\":\"opdup\",\"data\":\"# 1\\n\"}"
    local two="{\"v\":1,\"kind\":\"inject\",\"sid\":\"${sid}\",\"trace_id\":\"t1\",\"op_id\":\"opdup\",\"data\":\"# 2\\n\"}"
    combined=$(udsx "$sock" "${one};;;${two}" 1.0)
    if echo "$combined" | grep -q '"code":"ERR_DUPLICATE_OP"'; then
        emit "smoke4-duplicate-op" pass "ERR_DUPLICATE_OP returned"
    else
        emit "smoke4-duplicate-op" fail "combined=$(echo "$combined" | tr '\n' '|' | head -c 300)"
    fi
    teardown "$sid" "$pid"
}

smoke5() {
    local sid="m3-unk" sock pid line
    read -r pid sock < <(launch "$sid" bash -c 'sleep 30')
    line=$(udsx "$sock" "{\"v\":1,\"kind\":\"telepathy\",\"sid\":\"${sid}\"}" 0.5)
    if echo "$line" | grep -q '"code":"ERR_BAD_FRAME"' && echo "$line" | grep -q "kind_unknown"; then
        emit "smoke5-unknown-kind" pass "ERR_BAD_FRAME kind_unknown"
    else
        emit "smoke5-unknown-kind" fail "line=$(echo "$line" | tr '\n' '|')"
    fi
    teardown "$sid" "$pid"
}

smoke6() {
    local sid="m3-v2" sock pid line
    read -r pid sock < <(launch "$sid" bash -c 'sleep 30')
    line=$(udsx "$sock" "{\"v\":2,\"kind\":\"ping\"}" 0.5)
    if echo "$line" | grep -q '"code":"ERR_BAD_FRAME"' && echo "$line" | grep -q "version_unsupported"; then
        emit "smoke6-v2" pass "ERR_BAD_FRAME version_unsupported"
    else
        emit "smoke6-v2" fail "line=$(echo "$line" | tr '\n' '|')"
    fi
    teardown "$sid" "$pid"
}

smoke1
smoke2
smoke3
smoke4
smoke5
smoke6

printf '\nM3 smoke summary: %d pass / %d fail (logs: %s)\n' "$PASS" "$FAIL" "$LOG_DIR"
[[ "$FAIL" -eq 0 ]] || exit 1
