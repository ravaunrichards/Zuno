'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');
const errors = [];
const htmlPath = path.join(WEB, 'index.html');
if (!fs.existsSync(htmlPath)) errors.push('apps/web/index.html is missing');
let html = '';
if (fs.existsSync(htmlPath)) html = fs.readFileSync(htmlPath, 'utf8');
for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  const target = path.join(WEB, match[1]);
  if (!fs.existsSync(target)) errors.push('web asset reference does not resolve: ' + match[1]);
}
for (const file of ['manifest.webmanifest','gifts.json']) {
  const p = path.join(WEB, file);
  if (!fs.existsSync(p)) errors.push('required web file missing: ' + file);
  else if (file.endsWith('.json') || file.endsWith('.webmanifest')) {
    try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (error) { errors.push(file + ' is invalid JSON: ' + error.message); }
  }
}
for (const file of ['app.js','src/components/navigation.js','src/services/api-client.js','src/features/search/search.js','src/features/creation/composer.js','src/features/gifts/catalog.js','src/features/livestreaming/live-preview.js','src/features/actions.js']) {
  if (!fs.existsSync(path.join(WEB,file))) errors.push('required web module missing: ' + file);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const output = path.join(ROOT,'dist','web');
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
function copyDir(source,target) {
  for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const from = path.join(source,entry.name); const to = path.join(target,entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(to,{recursive:true}); copyDir(from,to); } else fs.copyFileSync(from,to);
  }
}
copyDir(WEB,output);
console.log('Web package built to dist/web after static reference and JSON validation.');
