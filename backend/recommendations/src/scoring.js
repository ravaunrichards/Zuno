'use strict';
// Deterministic ranking baseline, not machine learning. Safety/access filtering runs before scoring.
function candidateAllowed(c,ctx={}) {
  if(!c||c.deleted||c.moderationState==='removed'||c.visibility==='private') return false;
  if(c.authorId&&ctx.viewerId&&c.authorId===ctx.viewerId) return false;
  if(ctx.blockedProfileIds&&c.authorId&&ctx.blockedProfileIds.has(c.authorId)) return false;
  if(c.visibility==='followers'&&!(ctx.followedProfileIds&&ctx.followedProfileIds.has(c.authorId))) return false;
  if(c.ageRestricted&&!ctx.ageVerified) return false;
  return true;
}
function scoreCandidate(c,ctx={}) {
  const s=c.signals||{};
  const matches=ctx.topics&&c.topics?c.topics.filter((v)=>ctx.topics.has(v)).length:0;
  const followed=ctx.followedProfileIds&&ctx.followedProfileIds.has(c.authorId)?1:0;
  const hours=Math.max(0,(Date.now()-Date.parse(c.createdAt||new Date().toISOString()))/3600000);
  const freshness=1/(1+hours/24);
  const engagement=Math.log1p(Math.max(0,Number(s.qualityEngagement)||0));
  const penalty=Math.max(0,Number(s.userHidePenalty)||0)+Math.max(0,Number(s.repeatPenalty)||0);
  return Number((matches*3+followed*2+freshness+engagement-penalty).toFixed(5));
}
function rankCandidates(candidates,ctx={}) {
  return (Array.isArray(candidates)?candidates:[]).filter((c)=>candidateAllowed(c,ctx))
    .map((candidate)=>({candidate,score:scoreCandidate(candidate,ctx)})).sort((a,b)=>b.score-a.score);
}
module.exports={candidateAllowed,scoreCandidate,rankCandidates};
