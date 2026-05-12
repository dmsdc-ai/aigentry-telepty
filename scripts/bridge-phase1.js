#!/usr/bin/env node
// scripts/bridge-phase1.js — Phase 1 manual integration bridge (M5).
//
// Drives the Phase 1 Rust supervisor (target/release/telepty-supervisor-bin)
// through four parity scenarios and emits a JSON report on stdout. Node 0.3.5
// daemon parity is best-effort: the existing daemon speaks HTTP/WS on :3848,
// not the new NDJSON UDS wire, so byte-level parity is structurally infeasible
// without modifying daemon.js (forbidden by Q-C / plan §6.3 rollback claim).
// We therefore record whether the Node daemon is reachable and verify Rust-side
// behavior end-to-end; semantic parity is what Phase 1 actually validates.
//
// Constraints (per dispatch §M5):
// - Node stdlib only (no npm install).
// - No modifications to daemon.js / cli.js / tui.js.
// - Exit 0 iff all 4 Rust-side scenarios PASS.

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = process.cwd();
const BIN = path.join(REPO, 'target/release/telepty-supervisor-bin');
const SESSIONS = path.join(os.homedir(), '.telepty/sessions');
const RUN_ID = Math.random().toString(16).slice(2, 10);

if (!fs.existsSync(BIN)) {
    console.error(`missing ${BIN} — run: cargo build --release`); process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(p, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (fs.statSync(p).isSocket()) return true; } catch (_) {}
        await sleep(40);
    }
    return false;
}

function launchSupervisor(sid, ...argv) {
    const child = spawn(BIN, ['--sid', sid, '--', ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (b) => out.push(b));
    return { child, sockPath: path.join(SESSIONS, sid, 'supervisor.sock'), stdoutChunks: out };
}

function connectUds(sockPath) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(sockPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
}

function frameLines(stream, lines) {
    stream.on('data', (chunk) => {
        let acc = stream.__acc || '';
        acc += chunk.toString('utf8');
        const parts = acc.split('\n');
        acc = parts.pop();
        stream.__acc = acc;
        for (const p of parts) if (p) lines.push(p);
    });
}

async function nodeDaemonReachable() {
    return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:3848/api/sessions', { timeout: 500 }, (res) => {
            res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function scenario(name, run) {
    const start = Date.now();
    try {
        const detail = await run();
        return { name, verdict: detail.verdict || 'PASS', elapsed_ms: Date.now() - start, ...detail };
    } catch (e) {
        return { name, verdict: 'FAIL', elapsed_ms: Date.now() - start, error: String(e) };
    }
}

async function scenarioA() {
    // `echo hello` exits immediately — the supervisor finalizes (and unlinks
    // the socket) before any UDS dial would land. Skip the socket-wait and
    // verify via stdout + manifest unlink, matching the M1 spawn+observe demo.
    const sid = `bridge-${RUN_ID}-A`;
    const { child, stdoutChunks } = launchSupervisor(sid, 'echo', 'HELLO-FROM-A');
    const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const stdout = Buffer.concat(stdoutChunks).toString();
    const manifestGone = !fs.existsSync(path.join(SESSIONS, sid, 'manifest.json'));
    return {
        verdict: exit === 0 && stdout.includes('HELLO-FROM-A') && manifestGone ? 'PASS' : 'FAIL',
        rust_exit_code: exit,
        rust_stdout_has_hello: stdout.includes('HELLO-FROM-A'),
        rust_manifest_unlinked: manifestGone,
    };
}

async function scenarioB() {
    const sid = `bridge-${RUN_ID}-B`;
    const { child, sockPath } = launchSupervisor(sid, 'bash', '-c', 'sleep 30');
    if (!await waitForSocket(sockPath)) throw new Error('socket never appeared');
    const stream = await connectUds(sockPath);
    const lines = [];
    frameLines(stream, lines);
    stream.write(JSON.stringify({ v: 1, kind: 'kill', sid, trace_id: 'B', force: false }) + '\n');
    const exit = await new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
    stream.destroy();
    const shutdownDrain = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((f) => f && f.kind === 'shutdown_drain');
    const manifestGone = !fs.existsSync(path.join(SESSIONS, sid, 'manifest.json'));
    return {
        verdict: exit.code === 0 && shutdownDrain && manifestGone ? 'PASS' : 'FAIL',
        rust_exit_code: exit.code,
        rust_exit_signal: exit.sig,
        rust_shutdown_drain: shutdownDrain || null,
        rust_manifest_unlinked: manifestGone,
    };
}

async function scenarioC() {
    const sid = `bridge-${RUN_ID}-C`;
    const { child, sockPath } = launchSupervisor(sid, 'bash', '-c', 'sleep 30');
    if (!await waitForSocket(sockPath)) throw new Error('socket never appeared');
    const stream = await connectUds(sockPath);
    const lines = [];
    frameLines(stream, lines);
    stream.write(JSON.stringify({ v: 1, kind: 'telepathy', sid }) + '\n');
    await sleep(300);
    const err = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((f) => f && f.kind === 'error');
    stream.write(JSON.stringify({ v: 1, kind: 'kill', sid, trace_id: 'C-cleanup', force: true }) + '\n');
    await new Promise((resolve) => child.once('exit', resolve));
    stream.destroy();
    return {
        verdict: err && err.code === 'ERR_BAD_FRAME' && err.data === 'kind_unknown' ? 'PASS' : 'FAIL',
        rust_error_frame: err || null,
        node_status: 'DOCUMENTED_DIVERGENCE: 0.3.5 daemon uses HTTP/WS wire (port 3848), not NDJSON UDS — Phase 2 routing work.',
    };
}

async function scenarioD() {
    const sid = `bridge-${RUN_ID}-D`;
    const { child, sockPath } = launchSupervisor(sid, 'bash', '-c', 'sleep 30');
    if (!await waitForSocket(sockPath)) throw new Error('socket never appeared');
    const stream = await connectUds(sockPath);
    const lines = [];
    frameLines(stream, lines);
    const inject = (data) => JSON.stringify({ v: 1, kind: 'inject', sid, trace_id: 't-D', op_id: 'op-D', data });
    stream.write(inject('# first\n') + '\n');
    await sleep(200);
    stream.write(inject('# second\n') + '\n');
    await sleep(300);
    const dup = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((f) => f && f.kind === 'error' && f.code === 'ERR_DUPLICATE_OP');
    stream.write(JSON.stringify({ v: 1, kind: 'kill', sid, trace_id: 'D-cleanup', force: true }) + '\n');
    await new Promise((resolve) => child.once('exit', resolve));
    stream.destroy();
    return {
        verdict: dup ? 'PASS' : 'FAIL',
        rust_duplicate_frame: dup || null,
        node_status: 'DOCUMENTED_DIVERGENCE: 0.3.5 daemon has no idempotency LRU — Phase 2 task.',
    };
}

(async () => {
    const nodeReachable = await nodeDaemonReachable();
    const results = [];
    for (const [name, fn] of [['A', scenarioA], ['B', scenarioB], ['C', scenarioC], ['D', scenarioD]]) {
        results.push(await scenario(name, fn));
    }
    const report = {
        run_id: RUN_ID,
        bin: BIN,
        node_daemon_3848_reachable: nodeReachable,
        scenarios: results,
        overall: results.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL',
        rollback_claim: 'daemon.js cli.js tui.js untouched (Q-C r2).',
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.overall === 'PASS' ? 0 : 1);
})();
