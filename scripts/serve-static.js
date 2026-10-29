'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {URL}=require('node:url');
const MIME={
 '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
 '.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json',
 '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
 '.woff':'font/woff','.woff2':'font/woff2','.mp3':'audio/mpeg','.wav':'audio/wav','.glb':'model/gltf-binary','.gltf':'model/gltf+json'
};
function parseArgs(argv){
 const opts={root:'apps/web',port:Number(process.env.PORT||3000),host:process.env.HOST||'127.0.0.1'};
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--root'&&argv[i+1])opts.root=argv[++i];
  else if(argv[i]==='--port'&&argv[i+1])opts.port=Number(argv[++i]);
  else if(argv[i]==='--host'&&argv[i+1])opts.host=argv[++i];
  else throw new Error('Unknown or incomplete argument: '+argv[i]);
 }
 if(!Number.isInteger(opts.port)||opts.port<1||opts.port>65535)throw new Error('PORT must be an integer in 1..65535');
 return opts;
}
function inside(base,target){return target===base||target.startsWith(base+path.sep);}
function createStaticServer(rootDir){
 const root=fs.realpathSync(rootDir);
 return http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD','X-Content-Type-Options':'nosniff'});return res.end();}
  let requested;
  try{requested=decodeURIComponent(url.pathname);}catch(_){res.writeHead(400);return res.end('Bad path');}
  if(requested.includes('\0')){res.writeHead(400);return res.end('Bad path');}
  let file=path.resolve(root,'.'+requested);
  if(!inside(root,file)){res.writeHead(403);return res.end('Forbidden');}
  try{
    if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
    const real=fs.realpathSync(file);
    if(!inside(root,real)){res.writeHead(403);return res.end('Forbidden');}
    const stat=fs.statSync(real);
    if(!stat.isFile()){res.writeHead(404);return res.end('Not found');}
    const headers={
      'Content-Type':MIME[path.extname(real).toLowerCase()]||'application/octet-stream',
      'Content-Length':stat.size,
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'strict-origin-when-cross-origin',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':"default-src 'self'; connect-src 'self' http://localhost:4000; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
    };
    res.writeHead(200,headers);
    if(req.method==='HEAD')return res.end();
    fs.createReadStream(real).on('error',()=>{if(!res.headersSent)res.writeHead(500);res.end();}).pipe(res);
  }catch(_){res.writeHead(404,{'X-Content-Type-Options':'nosniff'});res.end('Not found');}
 });
}
if(require.main===module){
 try{
  const opts=parseArgs(process.argv.slice(2));
  const root=path.resolve(process.cwd(),opts.root);
  const server=createStaticServer(root);
  server.listen(opts.port,opts.host,()=>console.log('Serving '+root+' at http://'+opts.host+':'+opts.port));
 }catch(error){console.error(error.message);process.exit(1);}
}
module.exports={createStaticServer,parseArgs};
