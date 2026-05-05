'use strict';

const DEFAULT_PORT = 3848;

function parseHostSpec(value, defaultPort = DEFAULT_PORT) {
  if (value === undefined || value === null || value === '') {
    return { host: '127.0.0.1', port: defaultPort };
  }

  let raw = String(value).trim();
  if (!raw) {
    return { host: '127.0.0.1', port: defaultPort };
  }

  raw = raw.replace(/^https?:\/\//i, '');
  raw = raw.replace(/\/.*$/, '');

  const ipv6Bracketed = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Bracketed) {
    const port = ipv6Bracketed[2] ? Number(ipv6Bracketed[2]) : defaultPort;
    return { host: ipv6Bracketed[1], port };
  }

  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount > 1) {
    return { host: raw, port: defaultPort };
  }

  const hostPort = raw.match(/^(.+):(\d+)$/);
  if (hostPort) {
    return { host: hostPort[1], port: Number(hostPort[2]) };
  }

  return { host: raw, port: defaultPort };
}

function formatHostForUrl(host) {
  if (host && host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

function buildDaemonUrl(value, defaultPort = DEFAULT_PORT) {
  const { host, port } = parseHostSpec(value, defaultPort);
  return `http://${formatHostForUrl(host)}:${port}`;
}

function buildDaemonWsUrl(value, defaultPort = DEFAULT_PORT) {
  const { host, port } = parseHostSpec(value, defaultPort);
  return `ws://${formatHostForUrl(host)}:${port}`;
}

module.exports = {
  DEFAULT_PORT,
  parseHostSpec,
  formatHostForUrl,
  buildDaemonUrl,
  buildDaemonWsUrl
};
