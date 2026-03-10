#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.includes('daemon')) {
  console.log('Starting telepty daemon...');
  require('./daemon.js');
} else {
  console.log(`
Usage:
  npx @dmsdc-ai/aigentry-telepty daemon      # Start the background daemon
  npx @dmsdc-ai/aigentry-telepty spawn       # (Coming soon) Spawn an AI CLI
  npx @dmsdc-ai/aigentry-telepty list        # (Coming soon) List active PTYs
  npx @dmsdc-ai/aigentry-telepty inject      # (Coming soon) Inject context
  `);
}
