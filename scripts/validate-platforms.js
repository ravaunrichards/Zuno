'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const required=[
 'apps/web/index.html','apps/web/app.js','apps/web/manifest.webmanifest',
 'apps/android/settings.gradle.kts','apps/android/app/build.gradle.kts','apps/android/app/src/main/AndroidManifest.xml',
 'apps/ios/project.yml','apps/desktop/main.cjs','apps/desktop/preload.cjs','apps/desktop/package.json',
 'apps/tv/index.html','apps/tv/app.js','apps/admin/index.html','apps/admin/app.js',
 'apps/creator-studio/index.html','apps/creator-studio/app.js',
 'backend/api/src/server.js','database/migrations/0001_core_schema.sql',
 'database/migrations/0002_rls_policies.sql','database/migrations/0009_operational_jobs_and_delivery.sql',
 '.github/workflows/ci.yml','.env.example','README.md','pnpm-workspace.yaml','turbo.json'
];
const missing=required.filter((relative)=>!fs.existsSync(path.join(root,relative)));
const placeholders=[];
function walk(folder){
  if(!fs.existsSync(folder))return;
  for(const item of fs.readdirSync(folder,{withFileTypes:true})){
    const full=path.join(folder,item.name);
    if(item.isDirectory())walk(full);
    else if(item.name==='.gitkeep'||item.name==='gitkeep.txt')placeholders.push(path.relative(root,full));
  }
}
walk(root);
console.log(JSON.stringify({ok:missing.length===0&&placeholders.length===0,requiredChecked:required.length,missing,placeholderFiles:placeholders},null,2));
process.exit(missing.length||placeholders.length?1:0);
