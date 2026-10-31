'use strict';
// Reconstructed visible lines from the versioned normalized capture in #760.
// The original differential raw ANSI fixture is not present in this repository.
const claudeColor = 'thought for 1s)\nn65\n90\n' + '─'.repeat(120) + '\n'
  + ' ☐ Color choice \nWhich color do you prefer?\n❯ 1. Red\n   A warm, boldcolor\n2. Blue\n'
  + 'A cool, calm color\n3.Typesomething.\n' + '─'.repeat(120) + '\n'
  + '4.Chataboutthis\nEntertoselect·↑/↓tonavigate·Esctocancel\n';
const codexUpdate = '\n  ✨ Update available! 0.144.1 -> 0.145.0\n\n'
  + '  Release notes: https://github.com/openai/codex/releases/latest\n\n'
  + '› 1. Update now (runs `brew upgrade --cask codex`)\n  2. Skip\n  3. Skip until next version\n\n  Press enter to continue\n';
const paint = text => '\x1b[?1049h\x1b[2J\x1b[H' + text.replace(/\n/g, '\r\n');
module.exports = { claudeColor, codexUpdate, paint };
