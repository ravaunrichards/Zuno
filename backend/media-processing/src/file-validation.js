'use strict';
const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/opus']);
const DEFAULT_LIMITS = { image:20*1024*1024, video:500*1024*1024, audio:100*1024*1024 };
function validateUploadMetadata(input, limits = DEFAULT_LIMITS) {
  const errors=[];
  if(!input || typeof input!=='object') return {ok:false,errors:['INVALID_METADATA']};
  const type=String(input.mediaType||'');
  const mime=String(input.mimeType||'').toLowerCase();
  const size=Number(input.byteSize);
  if(!Object.prototype.hasOwnProperty.call(limits,type)) errors.push('UNSUPPORTED_MEDIA_TYPE');
  if(!ALLOWED_MIME.has(mime)) errors.push('UNSUPPORTED_MIME_TYPE');
  if(!Number.isSafeInteger(size)||size<=0) errors.push('INVALID_FILE_SIZE');
  else if(limits[type]&&size>limits[type]) errors.push('FILE_TOO_LARGE');
  const name=String(input.filename||'');
  if(!name||name.length>180||/[\x00-\x1f\\/]/.test(name)||name==='.'||name==='..') errors.push('INVALID_FILENAME');
  return {ok:errors.length===0,errors,metadata:errors.length?null:{mediaType:type,mimeType:mime,byteSize:size,filename:name.normalize('NFKC')}};
}
module.exports={validateUploadMetadata,ALLOWED_MIME,DEFAULT_LIMITS};
