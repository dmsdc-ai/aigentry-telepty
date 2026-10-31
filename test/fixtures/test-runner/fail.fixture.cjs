'use strict';

const assert = require('node:assert/strict');

require('node:test')('test-runner fixture: fails on purpose', () => {
  assert.fail('intentional fixture failure');
});
