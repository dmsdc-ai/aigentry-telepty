const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const CONFIG_DIR = path.join(os.homedir(), '.telepty');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function getConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); // Restrict permissions
  }

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      console.warn('⚠️ Warning: Failed to read config file, generating a new one.', e.message);
    }
  }

  // Generate new config
  const newConfig = {
    authToken: uuidv4(),
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), { mode: 0o600 });
  return newConfig;
}

module.exports = { getConfig };
