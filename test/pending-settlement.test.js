'use strict';
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, {
    skip: process.platform !== 'linux'
}, fn);
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { FileMailbox } = require('../src/mailbox');
const pending = require('../src/principal/pending-handoff');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-settlement-'));
    t.after(() => fs.rmSync(root, {
        recursive: true, force: true
    }));
    const mailbox = new FileMailbox({
        root, compactionThreshold: 1
    }), old = crypto.randomBytes(16).toString('base64url'), next = crypto.randomBytes(16).toString('base64url'), owner = crypto.randomUUID();
    mailbox.initializeCustody('mine');
    const message = {
        msg_id: 'message', from: 'claimed', to: 'mine', payload: 'private payload', created_at: Math.floor(Date.now() / 1000), attempt: 0
    };
    message.cooperative_handoff = {
        schema: 'telepty.pending-handoff-consent/v1', sid: 'mine', origin_epoch: old, origin_owner_generation: owner, recipient: {
            id: 'owner', audience: 'fixture'
        }, sender: {
            id: 'sender', key_id: 'sender', audience: 'fixture', source: 'ed25519'
        }, request_sha256: 'a'.repeat(64), proof_sha256: 'b'.repeat(64), message_sha256: pending.messageDigest(message), inject_id: null
    };
    const event = {
        id: crypto.randomUUID(), state: 'committed', epoch: old, next_epoch: next, owner_generation: owner, pending_policy: 'never-attempted', ...pending.snapshotReceipt([message]), pending_dispatch_started: [message.msg_id], pending_write_invoked: [message.msg_id]
    };
    const session = {
        id: 'mine', type: 'wrapped', cooperativeHandoffCapable: true, sessionEpoch: next, owningPrincipal: {
            id: 'owner', audience: 'fixture', source: 'ed25519'
        }, cooperativeHandoff: event
    };
    mailbox.enqueue(message);
    mailbox.dequeue('mine');
    mailbox.beginNonRetryableAttempt('mine', message.msg_id);
    return {
        root, mailbox, message, event, session, directory: path.join(root, 'mine')
    };
}
test('trusted transport ACK proof permits scoped settlement after compaction and restart', async (t) => {
    const f = fixture(t), settlement = require('../src/mailbox/handoff-settlement');
    const result = await resultFor(f);
    f.mailbox.ack('mine', f.message.msg_id, result);
    assert.equal(fs.readFileSync(path.join(f.directory, 'inbox.jsonl'), 'utf8'), '');
    assert.equal(pending.pendingNamespaceReserved(f.session, new FileMailbox({
        root: f.root
    })), false);
    assert.equal(fs.readFileSync(path.join(f.directory, 'handoff-settlements.jsonl'), 'utf8').includes('private payload'), false);
});
test('generic or serialized ACK metadata cannot create settlement evidence after compaction', async (t) => {
    const f = fixture(t);
    f.mailbox.ack('mine', f.message.msg_id, {
        success: true, measurement: 'bridge_child_write_invoked', settled: true
    });
    assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
    assert.equal(fs.existsSync(path.join(f.directory, 'handoff-settlements.jsonl')), false);
});
const settlement = require('../src/mailbox/handoff-settlement');
async function resultFor(f) {
    let frame;
    f.session.interactionOwnerGeneration = crypto.randomUUID();
    f.session.ownerWs = {
        readyState: 1, send: data => frame = JSON.parse(data)
    };
    const waiting = pending.requestPendingWrite(f.session, f.message);
    assert.equal(pending.acceptPendingReceipt('mine', f.session, f.session.ownerWs, {
        ...frame, type: 'pending_handoff_receipt', stage: 'child_write_invoked', bytes_written: null, submitted_bytes: Buffer.byteLength(frame.data)
    }), true);
    return settlement.captureSettlement(await waiting, f.session, f.message);
}
test('one opaque proof cannot be serialized or reused to grow evidence or settle another intent', async (t) => {
    const f = fixture(t), result = await resultFor(f);
    f.mailbox.ack('mine', f.message.msg_id, result);
    const file = path.join(f.directory, settlement.FILE), before = fs.readFileSync(file, 'utf8');
    f.mailbox.ack('mine', f.message.msg_id, result);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => settlement.captureSettlement(result, f.session, f.message));
    const old = f.event.id;
    f.event.id = crypto.randomUUID();
    assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
    f.event.id = old;
    assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), false);
});
for (const fault of ['before', 'after'])
    test(`settlement ${fault} rename uncertainty preserves payload/history and never grants release`, async (t) => {
        const f = fixture(t), result = await resultFor(f), rename = fs.renameSync;
        let tripped = false;
        try {
            fs.renameSync = function (from, to) {
                if (String(to).endsWith(settlement.FILE) && !tripped) {
                    tripped = true;
                    if (fault === 'after')
                        rename.call(fs, from, to);
                    throw Object.assign(new Error('synthetic storage fault'), {
                        code: 'EIO'
                    });
                }
                return rename.call(fs, from, to);
            };
            assert.throws(() => f.mailbox.ack('mine', f.message.msg_id, result), {
                code: 'HANDOFF_SETTLEMENT_UNAVAILABLE'
            });
        }
        finally {
            fs.renameSync = rename;
        }
        assert.equal(tripped, true);
        assert.equal(pending.pendingNamespaceReserved(f.session, new FileMailbox({
            root: f.root
        })), true);
        assert.equal(f.mailbox.messageState('mine', f.message.msg_id), 'dead_letter');
        assert.ok(fs.readFileSync(path.join(f.directory, 'inbox.jsonl'), 'utf8').includes('private payload'));
        require('../src/mailbox/storage').compact(f.directory, 0);
        assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
        assert.equal(fs.existsSync(path.join(f.directory, settlement.FILE)), fault === 'after');
    });
test('unknown DLQ history overrides both compacted settlement and present ACK evidence', async (t) => {
    for (const compacted of [false, true]) {
        const f = fixture(t);
        f.mailbox.config.compactionThreshold = compacted ? 1 : 100;
        f.mailbox.ack('mine', f.message.msg_id, await resultFor(f));
        assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), false);
        fs.writeFileSync(path.join(f.directory, 'dead-letter.jsonl'), JSON.stringify({
            msg_id: f.message.msg_id, delivery_uncertain: true, outcome: 'unknown', retryable: false
        }) + '\n');
        assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
    }
});
test('mismatched/ambiguous persisted settlement rows fail closed after normal ACK compaction', async (t) => {
    for (const field of ['session_id', 'session_epoch', 'origin_epoch', 'intent_id', 'pending_digest', 'message_digest', 'measurement', 'extra', 'duplicate']) {
        const f = fixture(t);
        f.mailbox.ack('mine', f.message.msg_id, await resultFor(f));
        const file = path.join(f.directory, settlement.FILE), row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (field === 'duplicate')
            fs.writeFileSync(file, JSON.stringify(row).slice(0, -1) + ',"mailbox_state":"pending"}\n');
        else {
            row[field] = field.includes('epoch') ? 'c'.repeat(22) : field.includes('digest') ? 'c'.repeat(64) : field === 'intent_id' ? crypto.randomUUID() : 'forged';
            fs.writeFileSync(file, JSON.stringify(row) + '\n');
        }
        assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true, field);
    }
});
test('bounded never-compacted ledger refuses capacity exhaustion without pruning proof', async (t) => {
    const f = fixture(t);
    const row = {
        schema: 'telepty.pending-transport-ack/v1', session_id: 'mine', session_epoch: f.event.next_epoch, origin_epoch: f.event.epoch, origin_owner_generation: f.event.owner_generation, intent_id: f.event.id, pending_digest: f.event.pending_digest, msg_id: 'old', message_digest: 'c'.repeat(64), measurement: 'bridge_child_write_invoked', mailbox_state: 'acked', consumption: 'unknown', reply: 'unknown', ack_at: Date.now()
    };
    const file = path.join(f.directory, settlement.FILE);
    fs.writeFileSync(file, Array.from({
        length: settlement.MAX_RECORDS
    }, (_, i) => JSON.stringify({
        ...row, msg_id: `old-${i}`
    })).join('\n') + '\n', {
        mode: 0o600
    });
    const before = fs.readFileSync(file, 'utf8');
    const result = await resultFor(f);
    assert.throws(() => f.mailbox.ack('mine', f.message.msg_id, result));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
});
test('forged transport result cannot mint an opaque settlement proof', t => {
    const f = fixture(t);
    assert.throws(() => settlement.captureSettlement({
        success: true, bytes_written: null, measurement: 'bridge_child_write_invoked'
    }, f.session, f.message), {
        code: 'HANDOFF_SETTLEMENT_UNAVAILABLE'
    });
});
test('ACK storage exception reports uncertainty instead of successful settlement', async () => {
    const { DeliveryEngine } = require('../src/mailbox/delivery');
    let invoked = 0, reported;
    const mailbox = {
        config: {
            deliveryPollMs: 200
        }, recoverInflight: () => 0, expireStale: () => 0, dequeue: () => ({
            msg_id: 'message'
        }), beginNonRetryableAttempt: () => true, ack: () => {
            throw Error('synthetic ACK failure');
        }
    };
    const engine = new DeliveryEngine(mailbox, {
        sessionResolver: () => ['mine'], deliverFn: async () => {
            invoked++;
            return {
                success: true, measurement: 'bridge_child_write_invoked'
            };
        }, onDelivery: (_sid, _id, result) => reported = result
    });
    await engine.tick();
    assert.equal(invoked, 1);
    assert.equal(reported.success, false);
    assert.equal(reported.delivery_uncertain, true);
    assert.equal(reported.code, 'MAILBOX_ACK_STORE_UNAVAILABLE');
});
test('settlement of an old epoch cannot release a changed session instance', async (t) => {
    const f = fixture(t);
    f.mailbox.ack('mine', f.message.msg_id, await resultFor(f));
    f.session.sessionEpoch = crypto.randomBytes(16).toString('base64url');
    assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true);
});
test('unsafe existing settlement authority and directory permissions never release custody', async (t) => {
    for (const kind of ['writable-file', 'readable-file', 'writable-session', 'readable-session', 'writable-ancestor', 'symlink', 'hardlink']) {
        const f = fixture(t);
        f.mailbox.ack('mine', f.message.msg_id, await resultFor(f));
        const file = path.join(f.directory, settlement.FILE);
        if (kind === 'writable-file')
            fs.chmodSync(file, 0o666);
        if (kind === 'readable-file')
            fs.chmodSync(file, 0o644);
        if (kind === 'writable-session')
            fs.chmodSync(f.directory, 0o777);
        if (kind === 'readable-session')
            fs.chmodSync(f.directory, 0o755);
        if (kind === 'writable-ancestor')
            fs.chmodSync(f.root, 0o777);
        if (kind === 'symlink') {
            fs.renameSync(file, file + '.saved');
            fs.symlinkSync(file + '.saved', file);
        }
        if (kind === 'hardlink')
            fs.linkSync(file, file + '.linked');
        try {
            assert.equal(pending.pendingNamespaceReserved(f.session, f.mailbox), true, kind);
        }
        finally {
            fs.chmodSync(f.root, 0o700);
            fs.chmodSync(f.directory, 0o700);
        }
    }
});
