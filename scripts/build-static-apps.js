'use strict';
const fs=require('node:fs');
const path=require('node:path');
const esbuild=require('esbuild');
const ROOT=path.resolve(__dirname,'..');
const TARGETS=['admin','creator-studio','tv'];
const chosen=process.argv[2]?[process.argv[2]]:TARGETS;
for(const name of chosen){
 if(!TARGETS.includes(name)){console.error('Unknown static app: '+name);process.exit(2);}
 const source=path.join(ROOT,'apps',name);
 const output=path.join(ROOT,'dist',name);
 if(!fs.existsSync(path.join(source,'index.html'))){console.error('Missing '+name+' index.html');process.exit(1);}
 fs.rmSync(output,{recursive:true,force:true});
 fs.mkdirSync(output,{recursive:true});
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(entry.isDirectory()||entry.name.startsWith('.')||['package.json','README.md'].includes(entry.name))continue;
  if(entry.name==='app.js'){
   esbuild.buildSync({
    entryPoints:[path.join(source,'app.js')],outfile:path.join(output,'app.js'),bundle:true,
    format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'none',logLevel:'silent'
   });
  }else fs.copyFileSync(path.join(source,entry.name),path.join(output,entry.name));
 }
 const config={
  apiBaseUrl:process.env.ZUNO_PUBLIC_API_BASE_URL||'',
  supabaseUrl:process.env.SUPABASE_URL||'',
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY||'',
  livekitUrl:process.env.LIVEKIT_URL||'',
  webBaseUrl:process.env.ZUNO_PUBLIC_WEB_BASE_URL||'../web/index.html'
 };
 fs.writeFileSync(path.join(output,'runtime-config.js'),'window.ZUNO_CONFIG = Object.freeze('+JSON.stringify(config)+');\n');
 const htmlPath=path.join(output,'index.html');
 let html=fs.readFileSync(htmlPath,'utf8');
 if(!html.includes('./runtime-config.js'))html=html.replace('</head>','<script src="./runtime-config.js"></script></head>');
 if(name==='creator-studio')html=html.replace('<script src="./app.js"></script>','<script type="module" src="./app.js"></script>');
 fs.writeFileSync(htmlPath,html);
}
console.log('Built static application bundles: '+chosen.join(', '));
