'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BLOCKED = 'WINDOWS_UPDATE_REQUIRES_EXTERNAL_COORDINATOR';
function readBoundedJSON(file, limit, filesystem) {
  let fd;
  try {
    const before = filesystem.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) return { state: 'unreadable' };
    fd = filesystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const after = filesystem.fstatSync(fd);
    if (after.ino !== before.ino || after.dev !== before.dev) return { state: 'unreadable' };
    const bytes = Buffer.alloc(limit + 1);
    const length = filesystem.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > limit) return { state: 'unreadable' };
    const body = bytes.subarray(0, length);
    if (!Buffer.from(body.toString('utf8')).equals(body)) return { state: 'unreadable' };
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { state: 'observed', value } : { state: 'unreadable' };
  } catch (reason) { return { state: reason.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
  finally { if (fd !== undefined) filesystem.closeSync(fd); }
}
function createUpdatePlan({ platform = process.platform, packageRoot = path.resolve(__dirname, '..'),
  homeDir = os.homedir(), nodeExecutable = process.execPath, pid = process.pid, filesystem = fs } = {}) {
  let root;
  try { root = filesystem.realpathSync(packageRoot); } catch { root = path.resolve(packageRoot); }
  const installed = readBoundedJSON(path.join(root, 'package.json'), 64 * 1024, filesystem);
  const state = readBoundedJSON(path.join(homeDir, '.telepty', 'daemon-state.json'), 16 * 1024, filesystem);
  const daemon = { observation: state.state, installation_verified: false, process_liveness: 'unknown' };
  if (state.value) {
    if (Number.isSafeInteger(state.value.pid) && state.value.pid > 0) daemon.recorded_pid = state.value.pid;
    if (Number.isInteger(state.value.port) && state.value.port > 0 && state.value.port <= 65535) daemon.recorded_port = state.value.port;
    if (typeof state.value.version === 'string' && /^[A-Za-z0-9.+_-]{1,64}$/.test(state.value.version)) daemon.recorded_version = state.value.version;
    if (typeof state.value.startedAt === 'string' && Number.isFinite(Date.parse(state.value.startedAt))) daemon.recorded_started_at = state.value.startedAt;
  }
  const windows = platform === 'win32';
  const blockers = windows ? [
    { code: 'CURRENT_CLI_HOLDERS_UNVERIFIED', reason: 'The current CLI is executing from this installation; an external coordinator must wait for it to exit before replacing the tree.' },
    { code: 'DAEMON_INSTALLATION_UNVERIFIED', reason: 'Legacy PID/port/version state is not a verified installation and process-birth binding; it cannot authorize a stop.' },
    { code: 'SERVICE_OWNERSHIP_UNVERIFIED', reason: 'Task presence/name alone does not prove its exact executable, installation, current state or authority to change it.' },
    { code: 'OTHER_HOLDERS_UNVERIFIED', reason: 'Allow bridges or native modules may still hold this installation; no complete mapped-file holder verification is available.' },
    { code: 'ROLLBACK_NOT_PREPARED', reason: 'No external durable snapshot/journal proves recovery of the package, bin links and original service state.' },
    { code: 'NPM_HOOK_ORDER_UNSAFE', reason: 'A new package lifecycle hook cannot guarantee quiescence before npm removes the old tree; direct npm installs remain outside this guard.' }
  ] : [];
  return { schema: 'telepty.update-plan/v1', platform, read_only: true, execution_supported: false,
    assessment: windows ? 'blocked' : 'informational', guard_blocks_update: windows,
    installation: { package_root: root, node_executable: nodeExecutable,
      package_observation: installed.state,
      package_name: installed.value && installed.value.name === '@dmsdc-ai/aigentry-telepty' ? installed.value.name : null,
      version: installed.value && typeof installed.value.version === 'string' && /^[A-Za-z0-9.+_-]{1,64}$/.test(installed.value.version) ? installed.value.version : null },
    current_process: { pid, package_exit_verified: false }, daemon,
    service: { observation: 'not-probed', ownership: 'unverified', original_running_state: 'unknown' },
    changes_performed: [], blockers,
    manual_external_plan: [
      { step: 1, action: 'Inspect the installed telepty/npm/node paths and exact service descriptor from an external shell outside this installation. Read-only commands include Get-Command telepty,npm,node -All, npm root --global, and telepty service status --json.' },
      { step: 2, action: 'Record the exact original service enabled/loaded/running state and matching daemon instance. Stop only a positively verified matching installation through its owning manager; never infer authority from a PID, task name or broad process-name scan.' },
      { step: 3, action: 'Finish or preserve work, close matching allow/native-module holders explicitly, and let this CLI exit. An external native holder check must confirm that the old tree is released before installation.' },
      { step: 4, action: 'Prepare and verify an external recovery snapshot plus durable journal for the installation, relevant bin links and original service configuration. This plan does not create a backup or promise rollback.' },
      { step: 5, action: 'Only after verified quiescence and recovery preparation, run the chosen package-manager upgrade from the external shell. Direct npm lifecycle ordering does not provide those prerequisites.' },
      { step: 6, action: 'After success, verify the installed package and matching daemon health before restoring only the original running state. Leave an originally stopped service stopped.' },
      { step: 7, action: 'After failure, do not restart a partial or unknown tree. Verify complete rollback first, then restore only the recorded original state. If rollback cannot be proved, leave it quiesced and report manual recovery required.' }
    ],
    limitations: ['This is a diagnostic plan, not an executable coordinator or a native Windows handle/rollback verifier.',
      'No npm, service-manager, network, PID signal, credential or installation mutation is performed by planning.',
      'The existing non-Windows update execution path is unchanged and is not certified by this plan.'] };
}
function formatUpdatePlan(plan) {
  const lines = [`Update plan: ${plan.assessment} (read-only; no actions performed)`,
    `Installation: ${JSON.stringify(plan.installation.package_root)}`];
  for (const blocker of plan.blockers) lines.push(`${blocker.code}: ${blocker.reason}`);
  lines.push('Manual external recovery plan:');
  for (const step of plan.manual_external_plan) lines.push(`${step.step}. ${step.action}`);
  return lines.join('\n');
}
function assertUpdateCanRun(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return;
  const plan = createUpdatePlan(options);
  throw Object.assign(new Error('Windows in-place self-update is blocked before npm. Run telepty update --plan --json and use an external verified quiescence/recovery workflow.'), { code: BLOCKED, plan });
}
module.exports = { BLOCKED, createUpdatePlan, formatUpdatePlan, assertUpdateCanRun };
