'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const required=[
 'apps/web/index.html','apps/web/app.js','apps/web/manifest.webmanifest','render.yaml',
 'apps/android/settings.gradle.kts','apps/android/app/build.gradle.kts','apps/android/app/src/main/AndroidManifest.xml',
 'apps/ios/project.yml','apps/desktop/main.cjs','apps/desktop/preload.cjs','apps/desktop/package.json',
 'apps/tv/index.html','apps/tv/app.js','apps/admin/index.html','apps/admin/app.js',
 'apps/creator-studio/index.html','apps/creator-studio/app.js',
 'backend/api/src/server.js','database/migrations/0001_core_schema.sql',
 'database/migrations/0002_rls_policies.sql','database/migrations/0010_close_friends_gifter_progression_and_earnings.sql',
 '.github/workflows/ci.yml','.env.example','README.md','pnpm-workspace.yaml','turbo.json'
];
const missing=required.filter((relative)=>!fs.existsSync(path.join(root,relative)));
const placeholders=[];
const ignored=new Set(['node_modules','.git','dist','build','.gradle','release','DerivedData','.next']);
function walk(folder){
 if(!fs.existsSync(folder))return;
 for(const item of fs.readdirSync(folder,{withFileTypes:true})){
  if(item.isDirectory()&&ignored.has(item.name))continue;
  const full=path.join(folder,item.name);
  if(item.isDirectory())walk(full);
  else if(item.name==='.gitkeep'||item.name==='gitkeep.txt')placeholders.push(path.relative(root,full));
 }
}
walk(root);
const packageRoots=['apps','backend','integrations','packages'];
const missingManifests=[];
for(const group of packageRoots){
 const folder=path.join(root,group);
 if(!fs.existsSync(folder))continue;
 for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const name=path.join(folder,entry.name);
  if(!fs.existsSync(path.join(name,'package.json')) && !(group==='apps'&&['android','ios'].includes(entry.name)))missingManifests.push(path.relative(root,name));
 }
}
const renderBlueprintPath=path.join(root,'render.yaml');
if(fs.existsSync(renderBlueprintPath)){
 const blueprint=fs.readFileSync(renderBlueprintPath,'utf8');
 const requiredRenderTokens=[
  'name: zuno-api','name: zuno-web','name: zuno-notification-worker','name: zuno-media-worker',
  'healthCheckPath: /health','staticPublishPath: dist',
  'key: SUPABASE_SERVICE_ROLE_KEY\n        sync: false',
  'key: PAYPAL_CLIENT_SECRET\n        sync: false',
  'key: LIVEKIT_API_SECRET\n        sync: false',
  'autoDeployTrigger: "off"'
 ];
 for(const token of requiredRenderTokens)if(!blueprint.includes(token))missing.push('Render Blueprint is missing a required deployment/security setting: '+token.split('\n')[0]);
 if(/(SUPABASE_SERVICE_ROLE_KEY|PAYPAL_CLIENT_SECRET|LIVEKIT_API_SECRET):\s*[^\s#]+/.test(blueprint))placeholders.push('render.yaml contains a possible hardcoded provider secret');
}
const desktopMain=fs.readFileSync(path.join(root,'apps/desktop/main.cjs'),'utf8');
const desktopPackage=JSON.parse(fs.readFileSync(path.join(root,'apps/desktop/package.json'),'utf8'));
const desktopBundleConfigured=desktopMain.includes("path.resolve(__dirname, '../../dist/web')") &&
 desktopMain.includes("path.join(process.resourcesPath, 'zuno-web')") &&
 Array.isArray(desktopPackage.build.extraResources) &&
 desktopPackage.build.extraResources.some(item=>item.to==='zuno-web'&&item.from==='../../dist/web');
if(!desktopBundleConfigured)missing.push('desktop production web bundle is not configured');
if(!desktopMain.includes('contextIsolation: true')||!desktopMain.includes('nodeIntegration: false')||!desktopMain.includes('sandbox: true'))missing.push('desktop renderer security settings are incomplete');
const result={ok:missing.length===0&&placeholders.length===0&&missingManifests.length===0,requiredChecked:required.length,missing,placeholderFiles:placeholders,missingWorkspaceManifests:missingManifests};
console.log(JSON.stringify(result,null,2));
process.exit(result.ok?0:1);
