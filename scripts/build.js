'use strict';
/** Minimal build orchestrator for environments without turbo installed.
 *  Validates that each workspace entry point parses; real app builds (web/
 *  android/ios/desktop/tv) require their own toolchains documented in docs/. */
require('child_process').execSync('node scripts/lint.js', { cwd: require('path').join(__dirname, '..'), stdio: 'inherit' });
console.log('build: source validated. Platform artifacts require their native toolchains (see docs/platforms.md).');
