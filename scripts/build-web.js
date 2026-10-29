'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

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
for (const file of ['app.js','runtime-config.js','src/components/navigation.js','src/services/api-client.js','src/features/search/search.js','src/features/creation/composer.js','src/features/gifts/catalog.js','src/features/gifts/preview3d.js','src/features/livestreaming/live-preview.js','src/features/livestreaming/live-room.js','src/features/actions.js','src/features/auth/session.js','src/features/notifications/notifications.js','src/features/auth/auth-ui.js','src/features/feed/feed.js','src/features/auth/wallet.js','src/features/communities/communities.js','src/features/marketplace/marketplace.js','src/features/messaging.js','src/features/subscriptions/subscriptions.js','src/features/profile/profile-settings.js','src/features/stories/stories.js','src/features/creation/media-upload.js']) {
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
if (!fs.existsSync(path.join(ROOT,'assets'))) { console.error('Root assets directory is missing'); process.exit(1); }
fs.cpSync(path.join(ROOT,'assets'),path.join(output,'assets'),{recursive:true});

// Bundle all browser modules, including the official LiveKit client SDK.
try {
  esbuild.buildSync({
    entryPoints: [path.join(WEB, 'app.js')],
    outfile: path.join(output, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    logLevel: 'silent'
  });
} catch (error) {
  console.error('Browser bundle failed:', error.message);
  process.exit(1);
}
const publicRuntime = {
  apiBaseUrl: process.env.ZUNO_PUBLIC_API_BASE_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  livekitUrl: process.env.LIVEKIT_URL || ''
};

const missingPublicRuntime = [
  ['ZUNO_PUBLIC_API_BASE_URL', publicRuntime.apiBaseUrl],
  ['SUPABASE_URL', publicRuntime.supabaseUrl],
  ['SUPABASE_ANON_KEY', publicRuntime.supabaseAnonKey]
].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
if (missingPublicRuntime.length) {
  console.error('Cannot build the production web app: missing required public runtime settings: ' + missingPublicRuntime.join(', '));
  process.exit(1);
}
console.log('Public runtime settings validated: API=' + new URL(publicRuntime.apiBaseUrl).origin +
  ', Supabase=' + new URL(publicRuntime.supabaseUrl).origin + ', anonymous key present (value hidden).');
fs.writeFileSync(path.join(output,'runtime-config.js'),'window.ZUNO_CONFIG = Object.freeze('+JSON.stringify(publicRuntime)+');\n');
const outputHtmlPath = path.join(output,'index.html');
let outputHtml = fs.readFileSync(outputHtmlPath,'utf8');
const webOrigins = [];
for (const candidate of [publicRuntime.apiBaseUrl, publicRuntime.supabaseUrl]) {
  if (!candidate) continue;
  try {
    const parsed = new URL(candidate);
    if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe URL');
    webOrigins.push(parsed.origin);
  } catch (_) {
    errors.push('invalid public web origin supplied to web build');
  }
}
let livekitOrigin = '';
if (publicRuntime.livekitUrl) {
  try {
    const parsed = new URL(publicRuntime.livekitUrl);
    if (!['wss:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe LiveKit URL');
    livekitOrigin = parsed.origin;
  } catch (_) {
    errors.push('invalid LiveKit public URL supplied to web build');
  }
}
if (errors.length) { console.error(errors.join('\\n')); process.exit(1); }
const allowedWebOrigins = [...new Set(webOrigins)].join(' ');
const connectOrigins = [...new Set([...webOrigins, livekitOrigin].filter(Boolean))].join(' ');
const connectDirective = "connect-src 'self' http://localhost:4000 https://*.supabase.co"+(connectOrigins ? " "+connectOrigins : "")+";";
outputHtml = outputHtml.replace(/connect-src[^;]*;/, connectDirective);
if (allowedWebOrigins) {
  outputHtml = outputHtml.replace("img-src 'self' data: blob: https://*.supabase.co;", "img-src 'self' data: blob: https://*.supabase.co "+allowedWebOrigins+";");
  outputHtml = outputHtml.replace("media-src 'self' blob: https://*.supabase.co;", "media-src 'self' blob: https://*.supabase.co "+allowedWebOrigins+";");
}
fs.writeFileSync(outputHtmlPath,outputHtml);
console.log('Web package built to dist/web. Runtime config contains only public API and Supabase anonymous-key values.');
