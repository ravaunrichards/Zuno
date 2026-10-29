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
 const requiredPublicSettings=[
  ['ZUNO_PUBLIC_API_BASE_URL',config.apiBaseUrl],
  ['SUPABASE_URL',config.supabaseUrl],
  ['SUPABASE_ANON_KEY',config.supabaseAnonKey]
 ].filter(([,value])=>!String(value||'').trim()).map(([name])=>name);
 if(requiredPublicSettings.length){
  console.error('Cannot build ZUNO '+name+': missing required public runtime settings: '+requiredPublicSettings.join(', '));
  process.exit(1);
 }
 const publicOrigins=[];
 for(const [label,value] of [['API',config.apiBaseUrl],['Supabase',config.supabaseUrl]]){
  try{
   const parsed=new URL(value);
   if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('unsafe URL');
   publicOrigins.push(parsed.origin);
  }catch(_){
   console.error('Cannot build ZUNO '+name+': invalid public '+label+' URL.');
   process.exit(1);
  }
 }
 console.log('ZUNO '+name+' public runtime settings validated: API='+new URL(config.apiBaseUrl).origin+
  ', Supabase='+new URL(config.supabaseUrl).origin+', anonymous key present (value hidden).');
 fs.writeFileSync(path.join(output,'runtime-config.js'),'window.ZUNO_CONFIG = Object.freeze('+JSON.stringify(config)+');\n');
 const htmlPath=path.join(output,'index.html');
 let html=fs.readFileSync(htmlPath,'utf8');
 if(!html.includes('./runtime-config.js'))html=html.replace('</head>','<script src="./runtime-config.js"></script></head>');
 html=html.replace(/<script(?: type="module")? src="\.\/app\.js"><\/script>/,'<script type="module" src="./app.js"></script>');
 // Where a static app defines a CSP, explicitly permit its configured API origin.
 // Without this, the browser blocks cross-origin API requests even when runtime config is correct.
 const connectDirective="connect-src 'self' http://localhost:4000 https://*.supabase.co "+[...new Set(publicOrigins)].join(' ')+";";
 html=html.replace(/connect-src[^;]*;/,connectDirective);
 const mediaOrigins=[...new Set(publicOrigins)].join(' ');
 html=html.replace(/img-src[^;]*;/,match=>match.includes(mediaOrigins)?match:match.replace(/;$/,' '+mediaOrigins+';'));
 html=html.replace(/media-src[^;]*;/,match=>match.includes(mediaOrigins)?match:match.replace(/;$/,' '+mediaOrigins+';'));
 fs.writeFileSync(htmlPath,html);
}
if (!process.argv[2]) fs.writeFileSync(path.join(ROOT,'dist','index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./web/index.html"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZUNO</title></head><body><p>Opening <a href="./web/index.html">ZUNO</a>…</p></body></html>' + String.fromCharCode(10));
console.log('Built static application bundles: '+chosen.join(', '));
