#!/usr/bin/env node
// Task 1215 — deterministic release/CI build of the bundled Darwin authority-file reader.
//
//   node scripts/build-authority-darwin.mjs --cc <clang> --sdk <MacOSX SDK dir> \
//     --node-headers <dir containing node_api.h> [--out <file>]
//
// Every input is explicit: no xcrun lookup, no PATH search for the compiler, no download, no npm.
// Produces ONE universal (arm64 + x86_64) Mach-O bundle, minimum macOS 11.0, Node-API 8, and a
// provenance record next to it. Children get a fixed environment with a private HOME and temporary
// directory created (0700, verified) beside the output and removed afterwards; nothing is inherited. It is a release/CI step only: it is NOT run by any npm lifecycle
// script, so installing the package never compiles anything.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = 'src/principal/native/authority-darwin.c';
const DEFAULT_OUT_REL = 'src/principal/native/prebuilt/darwin/authority-darwin.node';
const ARCHS = ['arm64', 'x86_64'];
const MIN_MACOS = '11.0';
const HEADERS = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];

// The private work directory (see below) is removed on EVERY exit path, including fail(): process.exit
// skips `finally`, so cleanup lives here. A cleanup failure is itself a build failure.
let removeWork = () => true;
function fail(message) {
  console.error(`build-authority-darwin: ${message}`);
  if (!removeWork()) console.error('build-authority-darwin: private work directory could not be removed');
  process.exit(1);
}
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!['--cc', '--sdk', '--node-headers', '--out'].includes(key) || typeof value !== 'string' || !value) fail(`bad argument ${key}`);
    if (Object.hasOwn(out, key)) fail(`duplicate ${key}`);
    out[key] = value;
  }
  for (const required of ['--cc', '--sdk', '--node-headers']) if (!out[required]) fail(`${required} is required`);
  return out;
}
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function absoluteExisting(value, kind) {
  if (!path.isAbsolute(value)) fail(`${kind} must be an absolute path`);
  if (!fs.existsSync(value)) fail(`${kind} does not exist: ${value}`);
  return fs.realpathSync(value);
}

if (process.platform !== 'darwin') fail('must run on a darwin host (Apple toolchain)');
const a = args(process.argv.slice(2));
const cc = absoluteExisting(a['--cc'], '--cc');
const sdk = absoluteExisting(a['--sdk'], '--sdk');
const headers = absoluteExisting(a['--node-headers'], '--node-headers');
for (const name of HEADERS) if (!fs.existsSync(path.join(headers, name))) fail(`--node-headers lacks ${name}`);
const lipo = path.join(path.dirname(cc), 'lipo');
if (!fs.existsSync(lipo)) fail(`lipo not found beside the compiler: ${lipo}`);
const source = path.join(ROOT, SOURCE_REL);
const out = path.resolve(ROOT, a['--out'] || DEFAULT_OUT_REL);
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o755 });

// Task 1215: a PRIVATE build environment. clang's universal driver and ld write per-arch intermediates
// to the temporary directory, which would otherwise default outside the build output. One fresh
// directory beside the output (mkdtemp, 0700) holds home/, tmp/ and the intermediate artifact; each is
// verified (real directory, owned by this uid, mode 0700) BEFORE any child is spawned, and the whole
// directory is removed on success and on failure.
let work;
try { work = fs.mkdtempSync(path.join(path.dirname(out), '.build-')); }
catch (error) { fail(`private build directory unavailable: ${error && error.code ? error.code : 'error'}`); }
removeWork = () => { try { fs.rmSync(work, { recursive: true, force: true }); return !fs.existsSync(work); } catch { return false; } };
const privateHome = path.join(work, 'home');
const privateTmp = path.join(work, 'tmp');
for (const dir of [privateHome, privateTmp]) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { fail(`private build directory unavailable: ${dir} (${error && error.code ? error.code : 'error'})`); }
}
for (const dir of [work, privateHome, privateTmp]) {
  let st;
  try { st = fs.lstatSync(dir); } catch { fail(`private build directory unavailable: ${dir}`); }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) {
    fail(`private build directory is not a 0700 directory owned by this user: ${dir}`);
  }
}
const tmp = path.join(work, `authority-darwin.node.tmp-${process.pid}`);

const argv = [
  ...ARCHS.flatMap(arch => ['-arch', arch]),
  `-mmacosx-version-min=${MIN_MACOS}`, '-isysroot', sdk, '-isystem', headers,
  '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-fvisibility=hidden', '-fstack-protector-strong',
  '-D_FORTIFY_SOURCE=2', '-DNAPI_VERSION=8',
  `-ffile-prefix-map=${ROOT}=.`, `-ffile-prefix-map=${headers}=node-headers`, `-ffile-prefix-map=${sdk}=sdk`,
  '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip',
  '-o', tmp, source,
];
// Exactly these variables reach every child (compiler, lipo, --version): nothing is inherited, so no
// credentials, proxies, SDKROOT/DEVELOPER_DIR/CPATH or caller HOME/TMPDIR can steer the build.
const env = { PATH: '/usr/bin:/bin', ZERO_AR_DATE: '1', SOURCE_DATE_EPOCH: '0', LANG: 'C',
  HOME: privateHome, TMPDIR: `${privateTmp}/`, TMP: privateTmp, TEMP: privateTmp };
const recordedEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.split(work).join('<work>')]));
try {
  execFileSync(cc, argv, { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'], shell: false });
  const archs = execFileSync(lipo, ['-archs', tmp], { env, encoding: 'utf8', shell: false }).trim().split(/\s+/).sort();
  if (JSON.stringify(archs) !== JSON.stringify([...ARCHS].sort())) fail(`unexpected architectures: ${archs.join(' ')}`);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, out);
  const provenance = {
    schema: 'telepty.native-build/v1', artifact: path.relative(ROOT, out), sha256: sha256(out), bytes: fs.statSync(out).size,
    archs, min_macos: MIN_MACOS, napi_version: 8, source: { path: SOURCE_REL, sha256: sha256(source) },
    compiler: { path: cc, sha256: sha256(cc), version: execFileSync(cc, ['--version'], { env, encoding: 'utf8', shell: false }).split('\n')[0] },
    sdk: { path: sdk, settings_sha256: fs.existsSync(path.join(sdk, 'SDKSettings.json')) ? sha256(path.join(sdk, 'SDKSettings.json')) : null },
    node_headers: Object.fromEntries(HEADERS.map(name => [name, sha256(path.join(headers, name))])),
    argv: argv.map(item => item === tmp ? '<out>' : item), env: recordedEnv, builder_node: process.version,
  };
  fs.writeFileSync(`${out}.provenance.json`, JSON.stringify(provenance, null, 2) + '\n', { mode: 0o644 });
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
if (!removeWork()) fail(`private work directory could not be removed: ${work}`);
console.log(`built ${path.relative(ROOT, out)} sha256=${sha256(out)} (private work directory removed)`);
