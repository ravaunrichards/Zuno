'use strict';
function normalizeQuery(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').slice(0,200);}
function visibleToViewer(item,ctx={}) {
  if(!item||item.deleted||item.moderationState==='removed') return false;
  if(item.visibility==='private'&&item.ownerId!==ctx.viewerId) return false;
  if(item.visibility==='followers'&&!(ctx.followedProfileIds&&ctx.followedProfileIds.has(item.ownerId))&&item.ownerId!==ctx.viewerId) return false;
  if(ctx.blockedProfileIds&&ctx.blockedProfileIds.has(item.ownerId)) return false;
  return true;
}
function searchRecords(records,query,ctx={}) {
  const q=normalizeQuery(query).toLocaleLowerCase();
  if(!q) return [];
  return (Array.isArray(records)?records:[]).filter((item)=>visibleToViewer(item,ctx))
    .map((item)=>({item,rank:[item.title,item.description,item.username].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)?1:0}))
    .filter((result)=>result.rank>0).sort((a,b)=>b.rank-a.rank);
}
module.exports={normalizeQuery,visibleToViewer,searchRecords};
