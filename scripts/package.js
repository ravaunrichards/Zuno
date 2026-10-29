'use strict';
/** Produces a clean source ZIP (excludes node_modules/.env/build artifacts). */
const { execSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const name = 'ZUNO-source.zip';
execSync(`cd "${path.dirname(ROOT)}" && zip -qr "${name}" "${path.basename(ROOT)}" -x '*/node_modules/*' -x '*/.env' -x '*/.git/*'`, { stdio: 'inherit' });
console.log('package: wrote ' + name);
