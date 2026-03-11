'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const prompts = require('prompts');

const TARGET_CLIENTS = {
  claude: {
    label: 'Claude Code',
    globalDir: () => path.join(os.homedir(), '.claude', 'skills'),
    projectDir: (cwd) => path.join(cwd, '.claude', 'skills'),
    defaultScope: 'global'
  },
  codex: {
    label: 'Codex',
    globalDir: () => path.join(os.homedir(), '.codex', 'skills'),
    projectDir: (cwd) => path.join(cwd, '.codex', 'skills'),
    defaultScope: 'global'
  },
  gemini: {
    label: 'Gemini',
    globalDir: () => path.join(os.homedir(), '.gemini', 'skills'),
    projectDir: (cwd) => path.join(cwd, '.gemini', 'skills'),
    defaultScope: 'project'
  }
};

function resolveSkillsSourceRoot(packageRoot = __dirname) {
  return path.join(packageRoot, 'skills');
}

function listPackagedSkills(packageRoot = __dirname) {
  const sourceRoot = resolveSkillsSourceRoot(packageRoot);
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }

  return fs.readdirSync(sourceRoot)
    .filter((name) => {
      const skillDir = path.join(sourceRoot, name);
      return fs.statSync(skillDir).isDirectory() && fs.existsSync(path.join(skillDir, 'SKILL.md'));
    })
    .sort()
    .map((name) => ({
      name,
      sourceDir: path.join(sourceRoot, name)
    }));
}

function resolveTargetDirectory(targetClient, scope, cwd, customPath) {
  const client = TARGET_CLIENTS[targetClient];
  if (!client) {
    throw new Error(`Unsupported target client: ${targetClient}`);
  }

  if (scope === 'custom') {
    if (!customPath) {
      throw new Error(`Missing custom path for ${targetClient}`);
    }
    return path.resolve(customPath);
  }

  if (scope === 'project') {
    return client.projectDir(cwd);
  }

  return client.globalDir();
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copySkillDirectory(sourceDir, destDir, overwrite = false) {
  if (fs.existsSync(destDir)) {
    if (!overwrite) {
      return 'exists';
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  ensureDirectory(path.dirname(destDir));
  fs.cpSync(sourceDir, destDir, { recursive: true });
  return 'installed';
}

async function promptForOverwrite(promptImpl, targetLabel, destDir) {
  const response = await promptImpl({
    type: 'select',
    name: 'action',
    message: `${targetLabel} already has ${path.basename(destDir)}. What should happen?`,
    choices: [
      { title: 'Overwrite existing copy', value: 'overwrite' },
      { title: 'Skip this target', value: 'skip' },
      { title: 'Cancel installation', value: 'cancel' }
    ],
    initial: 1
  });

  return response.action;
}

async function installSkillsWithPlan(plan, options = {}) {
  const promptImpl = options.promptImpl || prompts;
  const results = [];

  for (const item of plan) {
    const skillName = item.skill.name;
    const destDir = path.join(item.destRoot, skillName);
    let overwrite = false;

    if (fs.existsSync(destDir)) {
      const action = await promptForOverwrite(promptImpl, item.targetLabel, destDir);
      if (!action || action === 'cancel') {
        throw new Error('Installation cancelled.');
      }
      if (action === 'skip') {
        results.push({ ...item, destDir, status: 'skipped' });
        continue;
      }
      overwrite = true;
    }

    copySkillDirectory(item.skill.sourceDir, destDir, overwrite);
    results.push({ ...item, destDir, status: overwrite ? 'overwritten' : 'installed' });
  }

  return results;
}

async function runInteractiveSkillInstaller(options = {}) {
  const promptImpl = options.promptImpl || prompts;
  const packageRoot = options.packageRoot || __dirname;
  const cwd = options.cwd || process.cwd();
  const packagedSkills = listPackagedSkills(packageRoot);

  if (packagedSkills.length === 0) {
    console.log('No packaged skills were found.');
    return [];
  }

  let selectedSkills = packagedSkills;
  if (packagedSkills.length > 1) {
    const selectedSkillsAnswer = await promptImpl({
      type: 'multiselect',
      name: 'skills',
      message: 'Select skills to install',
      choices: packagedSkills.map((skill) => ({
        title: skill.name,
        value: skill.name
      })),
      min: 1
    });

    if (!selectedSkillsAnswer.skills || selectedSkillsAnswer.skills.length === 0) {
      console.log('Skipped skill installation.');
      return [];
    }

    selectedSkills = packagedSkills.filter((skill) => selectedSkillsAnswer.skills.includes(skill.name));
  } else {
    console.log(`Installing packaged skill: ${packagedSkills[0].name}`);
  }

  const selectedClientsAnswer = await promptImpl({
    type: 'multiselect',
    name: 'clients',
    message: 'Select target clients',
    choices: Object.entries(TARGET_CLIENTS).map(([key, value]) => ({
      title: value.label,
      value: key
    })),
    min: 1
  });

  if (!selectedClientsAnswer.clients || selectedClientsAnswer.clients.length === 0) {
    console.log('Skipped skill installation.');
    return [];
  }

  const destinationSelections = {};
  for (const clientKey of selectedClientsAnswer.clients) {
    const client = TARGET_CLIENTS[clientKey];
    const scopeAnswer = await promptImpl([
      {
        type: 'select',
        name: 'scope',
        message: `Install ${client.label} skills where?`,
        choices: [
          {
            title: `Global (${client.globalDir()})`,
            value: 'global'
          },
          {
            title: `Current Project (${client.projectDir(cwd)})`,
            value: 'project'
          },
          {
            title: 'Custom Path',
            value: 'custom'
          }
        ],
        initial: client.defaultScope === 'project' ? 1 : 0
      },
      {
        type: (prev) => prev === 'custom' ? 'text' : null,
        name: 'customPath',
        message: `Custom ${client.label} skills path:`,
        initial: client.projectDir(cwd),
        validate: (value) => value ? true : 'Required'
      }
    ]);

    if (!scopeAnswer.scope) {
      console.log('Skipped skill installation.');
      return [];
    }

    destinationSelections[clientKey] = {
      scope: scopeAnswer.scope,
      customPath: scopeAnswer.customPath || null
    };
  }

  const plan = [];

  for (const clientKey of selectedClientsAnswer.clients) {
    const client = TARGET_CLIENTS[clientKey];
    const selection = destinationSelections[clientKey];
    const destRoot = resolveTargetDirectory(clientKey, selection.scope, cwd, selection.customPath);

    for (const skill of selectedSkills) {
      plan.push({
        targetClient: clientKey,
        targetLabel: client.label,
        scope: selection.scope,
        destRoot,
        skill
      });
    }
  }

  console.log('\nInstalling telepty skills:');
  for (const item of plan) {
    console.log(`  - ${item.skill.name} -> ${item.targetLabel} (${item.scope})`);
    console.log(`    ${item.destRoot}`);
  }

  const results = await installSkillsWithPlan(plan, { promptImpl });

  console.log('\nSkill installation results:');
  for (const item of results) {
    const label = item.status === 'skipped' ? 'Skipped' : 'Installed';
    console.log(`  ${label}: ${item.skill.name} -> ${item.targetLabel}`);
    console.log(`    ${item.destDir}`);
  }

  return results;
}

module.exports = {
  TARGET_CLIENTS,
  copySkillDirectory,
  installSkillsWithPlan,
  listPackagedSkills,
  resolveTargetDirectory,
  runInteractiveSkillInstaller
};
