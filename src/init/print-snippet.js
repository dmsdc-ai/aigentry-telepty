'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const VERSION = 'telepty-snippet/v1';
const TARGETS = ['claude', 'agents', 'gemini'];
const FORMATS = ['markdown', 'json'];
const SNIPPET_DIR = path.join(__dirname, 'snippets');
const HELP = 'usage: telepty init --print-snippet [--target {claude|agents|gemini|all}] [--format {markdown|json}]';

function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function loadBody(target, options = {}) {
  const snippetDir = options.snippetDir || SNIPPET_DIR;
  return fs.readFileSync(path.join(snippetDir, `${target}.md`), 'utf8');
}

function expandTargets(target) {
  return target === 'all' ? TARGETS : [target];
}

function emitMarkdown(target, body) {
  const sha8 = sha256Hex(body).slice(0, 8);
  return `<!-- ${VERSION} BEGIN target=${target} sha256=${sha8} -->\n${body}<!-- ${VERSION} END target=${target} -->\n`;
}

function emitJson(target, body) {
  return JSON.stringify({
    version: VERSION,
    target,
    sha256: sha256Hex(body),
    body
  }) + '\n';
}

function parseArgs(args) {
  const parsed = {
    printSnippet: false,
    target: 'all',
    format: 'markdown',
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--print-snippet') {
      parsed.printSnippet = true;
    } else if (arg === '--target') {
      parsed.target = args[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--target=')) {
      parsed.target = arg.slice('--target='.length);
    } else if (arg === '--format') {
      parsed.format = args[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
    }
  }

  return parsed;
}

function buildOutput(args, options = {}) {
  const parsed = parseArgs(args);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  if (parsed.help || !parsed.printSnippet) {
    stdout.write(`${HELP}\n`);
    return 0;
  }

  if (![...TARGETS, 'all'].includes(parsed.target)) {
    stderr.write('error: --target must be one of claude, agents, gemini, all\n');
    return 2;
  }

  if (!FORMATS.includes(parsed.format)) {
    stderr.write('error: --format must be one of markdown, json\n');
    return 2;
  }

  try {
    const outputs = expandTargets(parsed.target).map((target) => {
      const body = loadBody(target, options);
      return parsed.format === 'json' ? emitJson(target, body) : emitMarkdown(target, body);
    });

    stdout.write(parsed.format === 'json' ? outputs.join('') : outputs.join('\n'));
    return 0;
  } catch (error) {
    stderr.write(`error: failed to generate telepty snippet: ${error.message}\n`);
    return 4;
  }
}

module.exports = {
  HELP,
  TARGETS,
  VERSION,
  buildOutput,
  emitJson,
  emitMarkdown,
  loadBody,
  main: buildOutput,
  sha256Hex
};
