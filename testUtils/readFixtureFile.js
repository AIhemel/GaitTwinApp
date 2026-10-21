// Node file access for tests, kept in plain JS so the app's TypeScript check doesn't need Node types.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', '__tests__', 'fixtures');

/**
 * Text of a fixture written by scripts/make_health_fixtures.py (.gz files are decompressed).
 * @param {string} name
 * @returns {string}
 */
function readFixtureText(name) {
  const buf = fs.readFileSync(path.join(DIR, name));
  return name.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

module.exports = { readFixtureText };
