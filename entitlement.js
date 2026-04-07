'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LICENSE_PATH = path.join(os.homedir(), '.aigentry', 'license.json');
const UPGRADE_URL = 'https://aigentry.dev/upgrade';

const FEATURES = {
  'telepty.core':            { tiers: ['free', 'pro', 'team'] },
  'telepty.multi_session':   { tiers: ['free', 'pro', 'team'] },
  'telepty.remote_sessions': { tiers: ['pro', 'team'] },
  'telepty.team_broadcast':  { tiers: ['team'] }
};

function readLicense() {
  try {
    if (fs.existsSync(LICENSE_PATH)) {
      const data = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
      // Grace period: expired Pro/Team gets 30 days before downgrade
      if (data.expires_at) {
        const expiry = new Date(data.expires_at).getTime();
        const grace = 30 * 24 * 60 * 60 * 1000;
        if (Date.now() > expiry + grace) {
          return { tier: 'free', expired: true };
        }
      }
      return { tier: data.tier || 'free', expired: false };
    }
  } catch {}
  return { tier: 'free', expired: false };
}

function checkEntitlement({ feature, currentUsage }) {
  const def = FEATURES[feature];
  if (!def) return { allowed: true, tier: 'free', reason: 'Unknown feature — allowing' };

  const license = readLicense();
  const tier = license.tier;

  // Feature available on this tier
  if (def.tiers.includes(tier)) {
    return { allowed: true, tier, upgrade_url: UPGRADE_URL };
  }

  // Free tier with limit
  if (tier === 'free' && def.freeLimit != null) {
    const current = currentUsage || 0;
    if (current < def.freeLimit) {
      return { allowed: true, tier, limit: { current, max: def.freeLimit } };
    }
    return {
      allowed: false, tier,
      reason: `Free limit reached: ${current}/${def.freeLimit}. Upgrade to Pro for unlimited.`,
      upgrade_url: UPGRADE_URL,
      limit: { current, max: def.freeLimit }
    };
  }

  // Not available on this tier
  const requiredTier = def.tiers[0];
  return {
    allowed: false, tier,
    reason: `Requires ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)} tier`,
    upgrade_url: UPGRADE_URL
  };
}

module.exports = { checkEntitlement, readLicense, LICENSE_PATH, FEATURES };
