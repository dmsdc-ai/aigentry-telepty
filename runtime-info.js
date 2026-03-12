'use strict';

const fs = require('fs');
const path = require('path');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absoluteOffset / 60));
  const offsetRemainder = pad(absoluteOffset % 60);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${sign}${offsetHours}:${offsetRemainder}`;
}

function getRuntimeInfo(packageRoot = __dirname) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const packageStat = fs.statSync(packageJsonPath);
  const updatedAt = packageStat.mtime;

  return {
    version: pkg.version || 'unknown',
    updatedAt,
    updatedAtLabel: formatTimestamp(updatedAt)
  };
}

module.exports = {
  formatTimestamp,
  getRuntimeInfo
};
