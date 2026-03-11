const pty = require('node-pty');
try {
  const p = pty.spawn('/bin/bash', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  });
  console.log('Success, PID:', p.pid);
  p.kill();
} catch (e) {
  console.error('Error:', e);
}
