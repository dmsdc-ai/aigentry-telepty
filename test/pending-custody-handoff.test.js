'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FileMailbox } = require('../src/mailbox');
for (const compactionThreshold of [1, 100]) test(`TTL cannot erase an unresolved fenced write (compaction ${compactionThreshold})`, t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-ttl-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const options = { root, ttlSecs: 10, inflightTimeoutSecs: 60, compactionThreshold };
    let mailbox = new FileMailbox(options);
    mailbox.initializeCustody('fixture');
    const message = { msg_id: 'uncertain', from: 'sender', to: 'fixture', payload: 'retain exact bytes 中', created_at: Math.floor(clock / 1000), attempt: 0 };
    mailbox.enqueue(message);
    mailbox.dequeue('fixture');
    assert.equal(mailbox.beginNonRetryableAttempt('fixture', message.msg_id), true);
    clock += 11000;
    mailbox = new FileMailbox(options);
    assert.equal(mailbox.recoverInflight('fixture'), 0);
    assert.equal(mailbox.expireStale('fixture'), 0);
    assert.equal(mailbox.messageState('fixture', message.msg_id), 'in_flight');
    assert.throws(() => mailbox.withCustodySnapshot('fixture', () => true));
    clock += 60000;
    assert.equal(mailbox.recoverInflight('fixture'), 1);
    assert.equal(mailbox.expireStale('fixture'), 0);
    require('../src/mailbox/storage').compact(path.join(root, 'fixture'), 1);
    mailbox = new FileMailbox(options);
    const quarantined = mailbox.peekDeadLetter('fixture');
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].payload, message.payload);
    assert.equal(quarantined[0].delivery_uncertain, true);
    assert.equal(quarantined[0].retryable, false);
    assert.equal(mailbox.messageState('fixture', message.msg_id), 'dead_letter');
    assert.equal(mailbox.dequeue('fixture'), null);
    assert.throws(() => mailbox.withCustodySnapshot('fixture', () => true));
    assert.ok(fs.readFileSync(path.join(root, 'fixture', 'inbox.jsonl'), 'utf8').includes(message.payload));
});
test('TTL still expires untouched pending and unfenced in-flight messages', t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-ttl-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mailbox = new FileMailbox({ root, ttlSecs: 10, compactionThreshold: 1 });
    for (const msg_id of ['unfenced', 'untouched']) mailbox.enqueue({ msg_id, to: 'fixture', payload: msg_id, created_at: Math.floor(clock / 1000), attempt: 0 });
    assert.equal(mailbox.dequeue('fixture').msg_id, 'unfenced');
    clock += 11000;
    assert.equal(mailbox.expireStale('fixture'), 2);
    assert.equal(mailbox.dequeue('fixture'), null);
});
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-handoff-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const mailbox = new FileMailbox({ root, compactionThreshold: 1 }); mailbox.initializeCustody('fixture'); const directory = path.join(root, 'fixture'); const msg = { msg_id: 'pending-one', from: 'original-claimed-sender', to: 'fixture', payload: 'literal\r\n中😀', created_at: Math.floor(Date.now() / 1000), attempt: 0, cooperative_handoff: { schema: 'synthetic-test-consent' } }; return { root, directory, mailbox, msg }; }
test('producer-recorded pristine pending custody includes exact content without rewriting queue bytes', t => { const f = fixture(t); f.mailbox.enqueue(f.msg); const before = ['inbox.jsonl', 'state.jsonl'].map(p => fs.readFileSync(path.join(f.directory, p), 'utf8')); const rows = f.mailbox.withNeverAttemptedCustody('fixture', rows => rows); assert.deepEqual(rows, [f.msg]); assert.deepEqual(['inbox.jsonl', 'state.jsonl'].map(p => fs.readFileSync(path.join(f.directory, p), 'utf8')), before); });
test('old unmarked or attempted pending rows cannot acquire never-attempted eligibility', t => { for (const mode of ['unmarked', 'retry', 'inflight', 'fenced', 'compact']) {
    const f = fixture(t);
    f.mailbox.enqueue(f.msg);
    if (mode === 'unmarked') {
        const p = path.join(f.directory, 'state.jsonl'), rows = fs.readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse);
        delete rows[0].never_attempted;
        fs.writeFileSync(p, rows.map(JSON.stringify).join('\n') + '\n');
    }
    else {
        f.mailbox.dequeue('fixture');
        if (mode === 'fenced')
            f.mailbox.beginNonRetryableAttempt('fixture', f.msg.msg_id);
        if (['retry', 'compact'].includes(mode))
            f.mailbox.nack('fixture', f.msg.msg_id, 'synthetic retry');
        if (mode === 'compact') {
            f.mailbox.enqueue({ ...f.msg, msg_id: 'terminal' });
            f.mailbox.ack('fixture', 'terminal');
        }
    }
    assert.throws(() => f.mailbox.withNeverAttemptedCustody('fixture', rows => rows), undefined, mode);
} });
test('unknown attempt history or DLQ never becomes empty or transferable custody', t => {
    for (const mode of ['dead-letter', 'later-acked', 'compacted', 'purged-dlq', 'purged']) {
        const f = fixture(t);
        f.mailbox.enqueue(f.msg);
        f.mailbox.dequeue('fixture');
        f.mailbox.beginNonRetryableAttempt('fixture', f.msg.msg_id);
        f.mailbox.withdraw('fixture', f.msg.msg_id, 'delivery_outcome_unknown', { inFlight: true, deliveryUncertain: true });
        if (mode === 'later-acked')
            fs.appendFileSync(path.join(f.directory, 'state.jsonl'), JSON.stringify({ msg_id: f.msg.msg_id, state: 'acked', ts: Math.floor(Date.now() / 1000) }) + '\n');
        if (['compacted', 'purged-dlq'].includes(mode)) {
            f.mailbox.enqueue({ ...f.msg, msg_id: 'known-terminal' });
            f.mailbox.ack('fixture', 'known-terminal');
            require('../src/mailbox/storage').compact(f.directory, 1);
        }
        if (mode === 'purged-dlq')
            f.mailbox.purgeDeadLetter('fixture');
        if (mode === 'purged')
            f.mailbox.purge('fixture');
        assert.throws(() => f.mailbox.snapshotCustody('fixture'), undefined, mode);
        assert.throws(() => f.mailbox.withNeverAttemptedCustody('fixture', rows => rows), undefined, mode);
    }
});
test('known dispatched ACK does not replay and compaction preserves a distinct untouched pending marker', t => { const f = fixture(t); f.mailbox.enqueue({ ...f.msg, msg_id: 'known' }); f.mailbox.dequeue('fixture'); f.mailbox.beginNonRetryableAttempt('fixture', 'known'); f.mailbox.ack('fixture', 'known'); f.mailbox.enqueue(f.msg); f.mailbox.enqueue({ ...f.msg, msg_id: 'terminal' }); f.mailbox.ack('fixture', 'terminal'); assert.deepEqual(f.mailbox.withNeverAttemptedCustody('fixture', rows => rows.map(row => row.msg_id)), [f.msg.msg_id]); });
test('DeliveryEngine rechecks a handoff fence after awaiting another session before touching target custody', async () => { const { DeliveryEngine } = require('../src/mailbox/delivery'); let unblock, entered, blocked = false; const first = new Promise(resolve => entered = resolve), wait = new Promise(resolve => unblock = resolve), touch = []; const mailbox = { config: { deliveryPollMs: 200 }, recoverInflight: id => { touch.push('recover:' + id); return 0; }, expireStale: id => { touch.push('expire:' + id); return 0; }, dequeue: id => ({ msg_id: id }), beginNonRetryableAttempt: () => true, ack: id => touch.push('ack:' + id) }; const engine = new DeliveryEngine(mailbox, { sessionResolver: () => ['other', 'fixture'], canProcess: id => id !== 'fixture' || !blocked, deliverFn: async (id) => { if (id === 'other') {
        entered();
        await wait;
    } return { success: true }; } }); const tick = engine.tick(); await first; blocked = true; unblock(); await tick; assert.ok(!touch.some(item => item.endsWith(':fixture'))); });
function protocol() { const crypto = require('node:crypto'), helper = require('../src/principal/pending-handoff'); const old = crypto.randomBytes(16).toString('base64url'), next = crypto.randomBytes(16).toString('base64url'), owner = crypto.randomUUID(), current = crypto.randomUUID(); const message = { msg_id: 'literal-one', from: 'original-claimed-label', to: 'fixture', payload: 'literal-中😀', created_at: Math.floor(Date.now() / 1000), attempt: 0 }; const session = { id: 'fixture', type: 'wrapped', command: 'node', cooperativeHandoffCapable: true, sessionEpoch: next, credentialGeneration: 2, owningPrincipal: { id: 'recipient', audience: 'fixture', source: 'ed25519' }, interactionOwnerGeneration: current, ownerWs: { readyState: 1, send: () => { } } }; message.cooperative_handoff = { schema: 'telepty.pending-handoff-consent/v1', sid: 'fixture', origin_epoch: old, origin_owner_generation: owner, recipient: { id: 'recipient', audience: 'fixture' }, sender: { id: 'sender', key_id: 'sender-key', audience: 'fixture', source: 'ed25519' }, request_sha256: 'a'.repeat(64), proof_sha256: 'b'.repeat(64), message_sha256: helper.messageDigest(message), inject_id: null }; session.cooperativeHandoff = { schema: 'telepty.cooperative-handoff-intent/v1', state: 'committed', id: crypto.randomUUID(), epoch: old, next_epoch: next, generation: 1, owner_generation: owner, actor: { id: 'recipient', key_id: 'recipient-key', audience: 'fixture', source: 'ed25519' }, at: Date.now(), expires_at: Date.now() + 4000, completed_at: Date.now(), exit_code: 0, exit_signal: null, pending_policy: 'never-attempted', ...helper.snapshotReceipt([message]) }; session.cooperativeHandoffAudit = [session.cooperativeHandoff]; return { helper, message, session }; }
test('pending bridge writer consumes one attempt before invoking and never parks or retries a duplicate', async () => { const f = protocol(), crypto = require('node:crypto'); let frame; f.session.ownerWs.send = data => frame = JSON.parse(data); const operation = f.helper.requestPendingWrite(f.session, f.message); let count = 0; const binding = { sid: 'fixture', session_epoch: f.session.sessionEpoch, owner_generation: f.session.interactionOwnerGeneration }; const writer = f.helper.createPendingWriter({ binding: () => binding, canWrite: () => true, write: () => count++ }); const receipt = writer(frame); assert.equal(receipt.stage, 'child_write_invoked'); assert.equal(receipt.bytes_written, null); assert.equal(receipt.submitted_bytes, Buffer.byteLength(f.message.payload)); assert.deepEqual(writer(frame), receipt); assert.equal(count, 1); assert.equal(f.helper.acceptPendingReceipt('fixture', f.session, f.session.ownerWs, receipt), true); assert.equal((await operation).measurement, 'bridge_child_write_invoked'); assert.equal(f.helper.acceptPendingReceipt('fixture', f.session, f.session.ownerWs, receipt), false); });
test('late, changed-owner, mismatched-payload, not-ready and partially throwing pending writes never gain a retry', async () => { for (const mode of ['late', 'owner', 'payload', 'blocked', 'partial']) {
    const f = protocol();
    let frame;
    f.session.ownerWs.send = data => frame = JSON.parse(data);
    const waiting = f.helper.requestPendingWrite(f.session, f.message, { timeoutMs: 40 });
    let clock = Date.now(), count = 0, binding = { sid: 'fixture', session_epoch: f.session.sessionEpoch, owner_generation: f.session.interactionOwnerGeneration };
    if (mode === 'payload')
        frame.data += 'changed';
    const writer = f.helper.createPendingWriter({ now: () => clock, binding: () => binding, canWrite: () => { if (mode === 'late')
            clock = frame.deadline + 1; if (mode === 'owner')
            binding = { ...binding, owner_generation: require('node:crypto').randomUUID() }; return mode !== 'blocked'; }, write: () => { count++; if (mode === 'partial')
            throw new Error('partial synthetic'); } });
    const receipt = writer(frame);
    writer(frame);
    assert.equal(count, mode === 'partial' ? 1 : 0, mode);
    if (mode === 'partial')
        assert.equal(receipt.stage, 'outcome_unknown');
    else
        assert.equal(receipt.stage, 'refused');
    f.helper.acceptPendingReceipt('fixture', f.session, f.session.ownerWs, receipt);
    assert.equal((await waiting).success, false);
} });
test('late owner receipt cannot be accepted just because its timeout callback has not run', async () => { const f = protocol(); let frame; f.session.ownerWs.send = data => frame = JSON.parse(data); const waiting = f.helper.requestPendingWrite(f.session, f.message, { timeoutMs: 50 }); const original = Date.now; try {
    Date.now = () => frame.deadline + 1;
    assert.equal(f.helper.acceptPendingReceipt('fixture', f.session, f.session.ownerWs, { ...frame, type: 'pending_handoff_receipt', stage: 'child_write_invoked', bytes_written: null, submitted_bytes: Buffer.byteLength(frame.data) }), false);
}
finally {
    Date.now = original;
} assert.equal((await waiting).success, false); });
test('dispatch claim precommit or visible uncertainty never sends and a restored visible claim cannot replay', async () => { for (const committed of [false, true]) {
    const f = protocol();
    let sends = 0;
    f.session.ownerWs.send = () => sends++;
    const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
    const context = createSessionDeliveryContext({ sessions: { fixture: f.session }, persistSessions: () => ({ ok: false, committed }), isOpenWebSocket: () => true });
    const result = await context.mailboxDeliveryOptions.deliverFn('fixture', f.message);
    assert.equal(result.delivery_uncertain, true);
    assert.equal(sends, 0);
    assert.equal(!!f.session.cooperativeHandoff.pending_dispatch_started, committed);
    if (committed) {
        const metadata = require('../src/session-store/persistence').serializePersistedSessions({ fixture: f.session }).fixture;
        const restored = require('../src/session-store/persistence').buildRestoredWrappedSession('fixture', metadata);
        restored.ownerWs = f.session.ownerWs;
        const again = createSessionDeliveryContext({ sessions: { fixture: restored }, persistSessions: () => { throw new Error('must not retry claim'); }, isOpenWebSocket: () => true });
        assert.equal((await again.mailboxDeliveryOptions.deliverFn('fixture', f.message)).delivery_uncertain, true);
        assert.equal(sends, 0);
    }
} });
test('old or mismatched pending-receipt capability leaves custody untouched before dequeue', async () => { const f = protocol(), { createSessionDeliveryContext } = require('../src/mailbox/session-delivery'), { recordReadyEvidence } = require('../src/readiness'); f.session.type = 'wrapped'; f.session.command = 'node'; f.session.sessionEpochProved = f.session.sessionEpoch; f.session.cooperativeHandoffCapable = true; f.session.readyKind = 'prompt_suffix_observed'; recordReadyEvidence(f.session); const context = createSessionDeliveryContext({ sessions: { fixture: f.session }, isOpenWebSocket: ws => ws?.readyState === 1 }); assert.equal(context.mailboxDeliveryOptions.canProcess('fixture'), false); f.session.pendingHandoffCapability = { owner: {}, generation: f.session.interactionOwnerGeneration }; assert.equal(context.mailboxDeliveryOptions.canProcess('fixture'), false); f.session.pendingHandoffCapability = { owner: f.session.ownerWs, generation: f.session.interactionOwnerGeneration }; assert.equal(context.mailboxDeliveryOptions.canProcess('fixture'), true); });
test('malformed journal evidence is not repaired away by compaction', t => { const f = fixture(t); f.mailbox.enqueue(f.msg); fs.appendFileSync(path.join(f.directory, 'state.jsonl'), '{"delivery_uncertain":broken}\n'); const before = ['inbox.jsonl', 'state.jsonl'].map(file => fs.readFileSync(path.join(f.directory, file), 'utf8')); assert.throws(() => require('../src/mailbox/storage').compact(f.directory, 0)); assert.deepEqual(['inbox.jsonl', 'state.jsonl'].map(file => fs.readFileSync(path.join(f.directory, file), 'utf8')), before); assert.throws(() => f.mailbox.snapshotCustody('fixture')); });
test('lost pending write receipt quarantines original payload with no automatic second dispatch', async (t) => { const f = protocol(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-timeout-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const mailbox = new FileMailbox({ root }); mailbox.initializeCustody('fixture'); mailbox.enqueue(f.message); let frames = 0; f.session.ownerWs.send = () => frames++; const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery'); const context = createSessionDeliveryContext({ sessions: { fixture: f.session }, isOpenWebSocket: ws => ws?.readyState === 1, interaction: require('../src/interaction'), persistSessions: () => ({ ok: true, committed: true }) }); const engine = new (require('../src/mailbox/delivery').DeliveryEngine)(mailbox, { deliverFn: context.mailboxDeliveryOptions.deliverFn, sessionResolver: () => ['fixture'] }); await engine.tick(); assert.equal(frames, 1); assert.equal(mailbox.messageState('fixture', f.message.msg_id), 'dead_letter'); assert.equal(mailbox.peekDeadLetter('fixture')[0].payload, f.message.payload); assert.equal(mailbox.peekDeadLetter('fixture')[0].delivery_uncertain, true); await engine.tick(); assert.equal(frames, 1); const inbox = fs.readFileSync(path.join(root, 'fixture', 'inbox.jsonl'), 'utf8'); assert.equal(JSON.parse(inbox.trim()).created_at, f.message.created_at); });
test('captured pending/unknown custody blocks production teardown, while known ACK evidence permits normal close', async (t) => {
    for (const settled of [false, true]) {
        const f = protocol(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-close-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const mailbox = new FileMailbox({ root, compactionThreshold: 100 });
        mailbox.initializeCustody('fixture');
        mailbox.enqueue(f.message);
        f.session.clients = new Set();
        if (settled) {
            f.session.cooperativeHandoff.pending_dispatch_started = [f.message.msg_id];
            f.session.cooperativeHandoff.pending_write_invoked = [f.message.msg_id];
            mailbox.dequeue('fixture');
            mailbox.beginNonRetryableAttempt('fixture', f.message.msg_id);
            mailbox.ack('fixture', f.message.msg_id);
        }
        if (settled) {
            assert.equal(f.helper.validPendingAudit(f.session.cooperativeHandoff), true);
            assert.equal(mailbox.withAcknowledgedCustody('fixture', f.session.cooperativeHandoff, () => true), true);
            assert.equal(f.helper.pendingNamespaceReserved(f.session, mailbox), false);
        }
        let kills = 0;
        const sessions = { fixture: f.session };
        const shared = { sessions, mailbox, revokeSessionCredential: () => { }, broadcastSessionEvent: () => { }, getSessionHealthStatus: () => 'READY', getSessionHealthReason: () => null, persistSessions: () => ({ ok: true, committed: true }), lifecycle: { killSessionProcess: async () => { kills++; return { pid: null }; }, cleanupSessionArtifacts: () => { } }, cancelModalParkPoll: () => { }, terminalBackend: { closeSurface: () => { } }, sessionStateManager: { unregister: () => { } }, busClients: new Set(), MACHINE_ID: 'fixture', buildSessionTransportBlock: () => ({}), buildSessionSemanticBlock: () => ({}) };
        const actions = require('../src/routes/session-actions').createSessionActions(shared);
        const result = await actions.teardownSessionById('fixture');
        if (settled) {
            assert.equal(kills, 1);
            assert.equal(result.success, true);
            assert.equal(sessions.fixture, undefined);
        }
        else {
            assert.equal(result.code, 'HANDOFF_FENCED');
            assert.equal(kills, 0);
            assert.equal(sessions.fixture, f.session);
            assert.equal(mailbox.messageState('fixture', f.message.msg_id), 'pending');
        }
    }
});
test('reservation checks do not initialize a mailbox for an ordinary registration record', () => { let factories = 0; assert.equal(require('../src/principal/pending-handoff').pendingNamespaceReserved({ id: 'ordinary' }, () => { factories++; throw new Error('must remain lazy'); }), false); assert.equal(factories, 0); });
test('missing ACK rows after normal compaction do not manufacture settlement', t => { const f = protocol(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-settled-proof-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const mailbox = new FileMailbox({ root, compactionThreshold: 100 }); mailbox.initializeCustody('fixture'); mailbox.enqueue(f.message); f.session.cooperativeHandoff.pending_dispatch_started = [f.message.msg_id]; f.session.cooperativeHandoff.pending_write_invoked = [f.message.msg_id]; mailbox.dequeue('fixture'); mailbox.beginNonRetryableAttempt('fixture', f.message.msg_id); mailbox.ack('fixture', f.message.msg_id); assert.equal(f.helper.pendingNamespaceReserved(f.session, mailbox), false); require('../src/mailbox/storage').compact(path.join(root, 'fixture'), 1); assert.equal(f.helper.pendingNamespaceReserved(f.session, mailbox), true); });
