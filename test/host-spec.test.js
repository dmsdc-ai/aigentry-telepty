'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseHostSpec,
  buildDaemonUrl,
  buildDaemonWsUrl,
  formatHostForUrl
} = require('../host-spec');

test('parseHostSpec returns localhost defaults for empty input', () => {
  assert.deepEqual(parseHostSpec(undefined), { host: '127.0.0.1', port: 3848 });
  assert.deepEqual(parseHostSpec(null), { host: '127.0.0.1', port: 3848 });
  assert.deepEqual(parseHostSpec(''), { host: '127.0.0.1', port: 3848 });
  assert.deepEqual(parseHostSpec('   '), { host: '127.0.0.1', port: 3848 });
});

test('parseHostSpec accepts bare host without port', () => {
  assert.deepEqual(parseHostSpec('192.168.4.165'), { host: '192.168.4.165', port: 3848 });
  assert.deepEqual(parseHostSpec('build-server.local'), { host: 'build-server.local', port: 3848 });
});

test('parseHostSpec extracts embedded port from host:port', () => {
  // Regression: previously TELEPTY_HOST=host:port produced http://host:port:3848/
  assert.deepEqual(parseHostSpec('192.168.4.165:3848'), { host: '192.168.4.165', port: 3848 });
  assert.deepEqual(parseHostSpec('192.168.4.165:9090'), { host: '192.168.4.165', port: 9090 });
});

test('parseHostSpec strips http://, https://, and trailing path', () => {
  assert.deepEqual(parseHostSpec('http://192.168.4.165:9090'), { host: '192.168.4.165', port: 9090 });
  assert.deepEqual(parseHostSpec('https://example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseHostSpec('http://example.com:9090/api/sessions'), { host: 'example.com', port: 9090 });
});

test('parseHostSpec uses provided default port when none embedded', () => {
  assert.deepEqual(parseHostSpec('host', 4000), { host: 'host', port: 4000 });
  assert.deepEqual(parseHostSpec('host:9090', 4000), { host: 'host', port: 9090 });
});

test('D2 (#672): MagicDNS / Tailnet names route by name, never require a raw tailnet IP', () => {
  // The seamless-cross-machine feature must stay IP-free from the caller's side:
  // `telepty inject worker@<magicdns-name>` resolves via Node's DNS (Tailscale's
  // resolver serves MagicDNS), so parseHostSpec must preserve the name verbatim.
  assert.deepEqual(parseHostSpec('windows-10-desktop'), { host: 'windows-10-desktop', port: 3848 });
  assert.deepEqual(parseHostSpec('win-t6t20oikemr.tail44b67e.ts.net'), { host: 'win-t6t20oikemr.tail44b67e.ts.net', port: 3848 });
  assert.deepEqual(parseHostSpec('macbook.tail44b67e.ts.net:9090'), { host: 'macbook.tail44b67e.ts.net', port: 9090 });
  assert.equal(buildDaemonUrl('windows-10-desktop'), 'http://windows-10-desktop:3848');
});

test('parseHostSpec handles bracketed IPv6 with and without port', () => {
  assert.deepEqual(parseHostSpec('[::1]:3848'), { host: '::1', port: 3848 });
  assert.deepEqual(parseHostSpec('[::1]'), { host: '::1', port: 3848 });
  assert.deepEqual(parseHostSpec('[fe80::1]:9090'), { host: 'fe80::1', port: 9090 });
});

test('parseHostSpec preserves bare IPv6 (no brackets, no port) literally', () => {
  // Without brackets, we cannot disambiguate "::1:9090" → port vs ipv6.
  // Treat as bare host with default port.
  assert.deepEqual(parseHostSpec('::1'), { host: '::1', port: 3848 });
  assert.deepEqual(parseHostSpec('fe80::1'), { host: 'fe80::1', port: 3848 });
});

test('buildDaemonUrl produces correct http URL for various inputs', () => {
  assert.equal(buildDaemonUrl('192.168.4.165'), 'http://192.168.4.165:3848');
  assert.equal(buildDaemonUrl('192.168.4.165:9090'), 'http://192.168.4.165:9090');
  // Regression: must NOT produce http://host:3848:3848/
  assert.equal(buildDaemonUrl('192.168.4.165:3848'), 'http://192.168.4.165:3848');
  assert.equal(buildDaemonUrl('http://192.168.4.165:3848'), 'http://192.168.4.165:3848');
});

test('buildDaemonWsUrl produces correct ws URL for various inputs', () => {
  assert.equal(buildDaemonWsUrl('192.168.4.165'), 'ws://192.168.4.165:3848');
  assert.equal(buildDaemonWsUrl('192.168.4.165:9090'), 'ws://192.168.4.165:9090');
  assert.equal(buildDaemonWsUrl('192.168.4.165:3848'), 'ws://192.168.4.165:3848');
});

test('formatHostForUrl brackets bare IPv6 addresses', () => {
  assert.equal(formatHostForUrl('::1'), '[::1]');
  assert.equal(formatHostForUrl('fe80::1'), '[fe80::1]');
  assert.equal(formatHostForUrl('192.168.4.165'), '192.168.4.165');
  // Already-bracketed input is preserved
  assert.equal(formatHostForUrl('[::1]'), '[::1]');
});
