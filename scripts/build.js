'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'lint.js')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'build-web.js')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'build-static-apps.js')], { cwd: root, stdio: 'inherit' });
console.log('JavaScript source and static web package checks completed. Native Android/iOS/Desktop/TV release builds need their target toolchains and are not implied by this command.');
