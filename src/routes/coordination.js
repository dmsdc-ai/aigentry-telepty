function ownRecord(records, id) {
  const descriptor = Object.getOwnPropertyDescriptor(records, id);
  const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readParticipants(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(body, 'participant_session_ids');
  if (!descriptor) return [];
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  const value = descriptor.value;
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  const participants = [];
  for (let i = 0; i < value.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) return null;
    const id = entry.value;
    if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 128
      || /[\u0000-\u001f\u007f-\u009f]/.test(id)) return null;
    participants.push(id);
  }
  return participants;
}

function registerHandoffRoutes(app, { handoffs, crypto, busClients }) {
  app.post('/api/handoff', (req, res) => {
    const { source_session_id, deliberation_id, synthesis, auto_execute } = req.body;
    if (!synthesis) return res.status(400).json({ error: 'synthesis is required' });

    const handoff_id = crypto.randomUUID();
    if (Object.prototype.hasOwnProperty.call(handoffs, handoff_id)) return res.status(409).json({ error: 'Handoff ID is already in use' });
    const handoff = {
      id: handoff_id,
      source_session_id: source_session_id || null,
      deliberation_id: deliberation_id || null,
      synthesis,
      status: 'pending',
      auto_execute: !!auto_execute,
      claimed_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress: [],
      result: null
    };
    Object.defineProperty(handoffs, handoff_id, { value: handoff, enumerable: true, writable: true, configurable: true });

    const busMsg = JSON.stringify({
      type: 'handoff.created',
      handoff_id,
      source_session_id: handoff.source_session_id,
      deliberation_id: handoff.deliberation_id,
      auto_execute: handoff.auto_execute,
      task_count: Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0,
      timestamp: handoff.created_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[HANDOFF] Created ${handoff_id} (${Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0} tasks)`);
    res.status(201).json({ handoff_id, status: 'pending' });
  });

  app.get('/api/handoff', (req, res) => {
    const status = req.query.status;
    const records = Object.keys(handoffs).map(id => ownRecord(handoffs, id));
    if (records.some(record => record === null)) return res.status(409).json({ error: 'Invalid existing handoff record' });
    const list = records
      .filter(h => !status || h.status === status)
      .map(h => ({
        id: h.id,
        status: h.status,
        deliberation_id: h.deliberation_id,
        source_session_id: h.source_session_id,
        auto_execute: h.auto_execute,
        claimed_by: h.claimed_by,
        task_count: Array.isArray(h.synthesis.tasks) ? h.synthesis.tasks.length : 0,
        created_at: h.created_at,
        updated_at: h.updated_at
      }));
    res.json(list);
  });

  app.get('/api/handoff/:id', (req, res) => {
    const handoff = ownRecord(handoffs, req.params.id);
    if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
    res.json(handoff);
  });

  app.post('/api/handoff/:id/claim', (req, res) => {
    const handoff = ownRecord(handoffs, req.params.id);
    if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
    if (handoff.status !== 'pending') {
      return res.status(409).json({ error: `Handoff already ${handoff.status}`, claimed_by: handoff.claimed_by });
    }

    const { agent_session_id } = req.body;
    if (!agent_session_id) return res.status(400).json({ error: 'agent_session_id is required' });

    handoff.status = 'claimed';
    handoff.claimed_by = agent_session_id;
    handoff.updated_at = new Date().toISOString();

    const busMsg = JSON.stringify({
      type: 'handoff.claimed',
      handoff_id: handoff.id,
      agent_session_id,
      timestamp: handoff.updated_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[HANDOFF] ${handoff.id} claimed by ${agent_session_id}`);
    res.json({ success: true, handoff_id: handoff.id, status: 'claimed' });
  });

  app.patch('/api/handoff/:id', (req, res) => {
    const handoff = ownRecord(handoffs, req.params.id);
    if (!handoff) return res.status(404).json({ error: 'Handoff not found' });

    const { status, message, result } = req.body;
    const validTransitions = {
      pending: ['claimed'],
      claimed: ['executing', 'failed'],
      executing: ['completed', 'failed'],
    };

    if (status) {
      const allowed = validTransitions[handoff.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `Invalid transition: ${handoff.status} -> ${status}` });
      }
      handoff.status = status;
    }

    if (message) {
      handoff.progress.push({ message, timestamp: new Date().toISOString() });
    }

    if (result) {
      handoff.result = result;
    }

    handoff.updated_at = new Date().toISOString();

    const busMsg = JSON.stringify({
      type: `handoff.${handoff.status}`,
      handoff_id: handoff.id,
      claimed_by: handoff.claimed_by,
      message: message || null,
      timestamp: handoff.updated_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[HANDOFF] ${handoff.id} -> ${handoff.status}${message ? ': ' + message : ''}`);
    res.json({ success: true, handoff_id: handoff.id, status: handoff.status });
  });
}

function registerThreadRoutes(app, { threads, crypto, busClients }) {
  app.post('/api/threads', (req, res) => {
    const participant_session_ids = readParticipants(req.body);
    if (participant_session_ids === null) return res.status(400).json({ error: 'Invalid participant_session_ids' });
    const { topic, orchestrator_session_id, context } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    const thread_id = crypto.randomUUID();
    if (Object.prototype.hasOwnProperty.call(threads, thread_id)) return res.status(409).json({ error: 'Thread ID is already in use' });
    const thread = {
      id: thread_id,
      topic,
      orchestrator_session_id: orchestrator_session_id || null,
      participant_session_ids,
      context: context || null,
      status: 'active',
      message_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null
    };
    Object.defineProperty(threads, thread_id, { value: thread, enumerable: true, writable: true, configurable: true });

    const busMsg = JSON.stringify({
      type: 'thread.opened',
      thread_id,
      topic,
      orchestrator_session_id: thread.orchestrator_session_id,
      participant_session_ids: thread.participant_session_ids,
      timestamp: thread.created_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[THREAD] Opened ${thread_id}: "${topic}" (${thread.participant_session_ids.length} participants)`);
    res.status(201).json({ thread_id, status: 'active' });
  });

  app.get('/api/threads', (req, res) => {
    const status = req.query.status;
    const records = Object.keys(threads).map(id => ownRecord(threads, id));
    if (records.some(record => record === null)) return res.status(409).json({ error: 'Invalid existing thread record' });
    const list = records
      .filter(t => !status || t.status === status)
      .map(t => ({
        id: t.id,
        topic: t.topic,
        status: t.status,
        orchestrator_session_id: t.orchestrator_session_id,
        participant_count: t.participant_session_ids.length,
        message_count: t.message_count,
        created_at: t.created_at,
        updated_at: t.updated_at
      }));
    res.json(list);
  });

  app.get('/api/threads/:id', (req, res) => {
    const thread = ownRecord(threads, req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  });

  app.patch('/api/threads/:id', (req, res) => {
    const thread = ownRecord(threads, req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const { status, message_count } = req.body;
    if (typeof message_count === 'number' && (!Number.isSafeInteger(message_count) || message_count < 0)) {
      return res.status(400).json({ error: 'Invalid message_count' });
    }

    if (status === 'closed' && thread.status === 'active') {
      thread.status = 'closed';
      thread.closed_at = new Date().toISOString();
      thread.updated_at = thread.closed_at;

      const busMsg = JSON.stringify({
        type: 'thread.closed',
        thread_id: thread.id,
        topic: thread.topic,
        message_count: thread.message_count,
        timestamp: thread.closed_at
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(busMsg);
      });

      console.log(`[THREAD] Closed ${thread.id}: "${thread.topic}" (${thread.message_count} messages)`);
    }

    if (typeof message_count === 'number') {
      thread.message_count = message_count;
      thread.updated_at = new Date().toISOString();
    }

    res.json({ success: true, thread_id: thread.id, status: thread.status });
  });
}

module.exports = { registerHandoffRoutes, registerThreadRoutes };
