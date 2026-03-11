'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  copySkillDirectory,
  listPackagedSkills,
  resolveTargetDirectory,
  runInteractiveSkillInstaller
} = require('../skill-installer');

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function createSkillPackage(packageRoot, skillName = 'telepty') {
  const skillDir = path.join(packageRoot, 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`);
  return skillDir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop(), { recursive: true, force: true });
  }
});

test('listPackagedSkills discovers packaged skills with SKILL.md', () => {
  const packageRoot = makeTempDir('telepty-skill-package-');
  createSkillPackage(packageRoot, 'telepty');
  createSkillPackage(packageRoot, 'other-skill');

  const skills = listPackagedSkills(packageRoot);
  assert.deepEqual(skills.map((skill) => skill.name), ['other-skill', 'telepty']);
});

test('resolveTargetDirectory maps global and project roots for each client', () => {
  const cwd = '/tmp/my-project';
  assert.match(resolveTargetDirectory('claude', 'global', cwd), /\/\.claude\/skills$/);
  assert.equal(resolveTargetDirectory('claude', 'project', cwd), '/tmp/my-project/.claude/skills');
  assert.match(resolveTargetDirectory('codex', 'global', cwd), /\/\.codex\/skills$/);
  assert.equal(resolveTargetDirectory('codex', 'project', cwd), '/tmp/my-project/.codex/skills');
  assert.match(resolveTargetDirectory('gemini', 'global', cwd), /\/\.gemini\/skills$/);
  assert.equal(resolveTargetDirectory('gemini', 'project', cwd), '/tmp/my-project/.gemini/skills');
});

test('runInteractiveSkillInstaller installs selected skills into multiple clients', async () => {
  const packageRoot = makeTempDir('telepty-installer-package-');
  createSkillPackage(packageRoot, 'telepty');

  const cwd = makeTempDir('telepty-installer-project-');
  const homeDir = makeTempDir('telepty-installer-home-');
  const originalHome = os.homedir;
  os.homedir = () => homeDir;

  const scopes = [
    { scope: 'global', customPath: null },
    { scope: 'project', customPath: null }
  ];

  const answers = {
    clients: ['codex', 'gemini']
  };

  const promptImpl = async (questionSet) => {
    if (Array.isArray(questionSet)) {
      return scopes.shift();
    }

    if (!(questionSet.name in answers)) {
      throw new Error(`Unexpected prompt: ${questionSet.name}`);
    }

    return { [questionSet.name]: answers[questionSet.name] };
  };

  try {
    const results = await runInteractiveSkillInstaller({ packageRoot, cwd, promptImpl });
    assert.equal(results.length, 2);
    assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'skills', 'telepty', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(cwd, '.gemini', 'skills', 'telepty', 'SKILL.md')), true);
  } finally {
    os.homedir = originalHome;
  }
});

test('copySkillDirectory reports existing destination without overwrite', () => {
  const sourceRoot = makeTempDir('telepty-skill-source-');
  const destRoot = makeTempDir('telepty-skill-dest-');
  const sourceDir = createSkillPackage(sourceRoot, 'telepty');
  const destDir = path.join(destRoot, 'telepty');

  assert.equal(copySkillDirectory(sourceDir, destDir, false), 'installed');
  assert.equal(copySkillDirectory(sourceDir, destDir, false), 'exists');
});
