'use strict';
// Test-owned worker: hold query completion until the HTTP health assertion releases it.
const { workerData, parentPort } = require('node:worker_threads');
const state = new Int32Array(workerData.release);
workerData.started.postMessage('query_work_held');
workerData.started.close();
while (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0);
parentPort.postMessage({ ok: true, json: '{"injects":[],"next_cursor":null}' });
