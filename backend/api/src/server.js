'use strict';
/**
 * ZUNO HTTP API.
 * User data reads/writes use a provider-verified Supabase JWT and the PostgREST
 * anon key so database RLS remains active. Privileged reads are narrowly
 * allowlisted and used only where the route applies its own authorization.
 * Financial mutations remain disabled until the persistent, reconciled
 * provider transaction is complete.
 */
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { load, validateRequired } = require('../../../config');
const livekit = require('../../../integrations/livekit');
const { rankCandidates } = require('../../recommendations/src/scoring');
const { monthlyPeriodStart, weeklyPeriodStart } = require('../../../packages/gift-engine/src/rankings');
const { authenticateProfile, userRest, adminRest, adminRpc, selectAdminRows, profileProjection } = require('./auth');

const config = load();
const envCheck = validateRequired(config);
if (!envCheck.ok) console.warn('[config] problems:', envCheck.problems.join('; '));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POST_KINDS = new Set(['short_video','long_video','photo','gallery','text','audio','story']);
const AUDIENCES = new Set(['public','followers','private']);
const PROFILE_FIELDS = new Set(['display_name','bio','avatar_url','cover_url','visibility']);

const DIRECT_TABLE_LIMIT = 100;
const MAX_REQUEST_BYTES = 1_000_000;

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders
  });
  res.end(data);
}
function error(res, status, code, message) {
  return json(res, status, { ok: false, code, ...(message ? { message } : {}) });
}
function badDatabase(res, result, fallback = 'DATA_UNAVAILABLE') {
  const status = [400,401,403,404,409,413,422].includes(result.status) ? result.status : 503;
  return error(res, status, result.code || fallback, status === 503 ? 'The data service is not available for this operation.' : 'The request could not be completed.');
}
function query(params) {
  const output = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) output.set(key, String(value));
  }
  return output;
}
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function asSafeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return u.protocol === 'https:'; } catch (_) { return false; }
}
function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
function profileIdIn(ids) {
  const clean = [...new Set(ids.filter(uuid))];
  return clean.length ? 'in.(' + clean.join(',') + ')' : 'in.(00000000-0000-4000-8000-000000000000)';
}
function safeRoom(room, host) {
  return {
    id: room.id, title: room.title || 'LIVE room', category: room.category || 'General',
    state: room.state, startedAt: room.started_at || null,
    host: host ? { id: host.id, username: host.username, displayName: host.display_name || host.username, avatarUrl: host.avatar_url || null, isVerified: Boolean(host.is_verified) } : null
  };
}
async function requireSession(req, res) {
  const session = await authenticateProfile(req, config);
  if (!session.ok) error(res, session.status, session.code, session.message);
  return session;
}
async function rowsForUser(session, table, values, options = {}) {
  return userRest(config, session, table, query(values), options.method || 'GET', options.body ?? null);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + config.apiPort);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', configured: config.configured, ts: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/api/meta/readiness') {
      return json(res, 200, {
        ok: true,
        integrations: {
          supabase: config.configured.supabase ? 'configured' : 'not_configured',
          livekit: config.configured.livekit ? 'configured' : 'not_configured',
          paypal: config.configured.paypal ? 'configured' : 'not_configured'
        },
        featureFlags: { productionPayments: config.features.productionPayments, payouts: config.features.payouts, liveRecording: config.features.liveRecording },
        note: 'Configured means required environment values exist; it does not prove authentication, provider transactions or production readiness.'
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/meta/public-config') {
      return json(res, 200, {
        ok: true,
        supabaseUrl: config.supabase.url || null,
        supabaseAnonKey: config.supabase.anonKey || null,
        apiBaseUrl: config.apiPublicBaseUrl || ''
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog/gifts') {
      const giftsResult = await adminRest(config, 'gift_definitions', query({ select: 'id,name,category,tier,price_coins,unlock_rule,model_path,audio_path,audio_status,asset_version,license', order: 'tier.asc,name.asc', limit: '200' }));
      if (giftsResult.ok && Array.isArray(giftsResult.data) && giftsResult.data.length) {
        const category = url.searchParams.get('category');
        const items = category ? giftsResult.data.filter((gift) => String(gift.category || '').toLowerCase().includes(category.toLowerCase())) : giftsResult.data;
        return json(res, 200, { ok: true, count: items.length, gifts: items.map((gift) => ({ id: gift.id, name: gift.name, category: gift.category, tier: gift.tier, priceCoins: gift.price_coins, unlockRule: gift.unlock_rule, modelPath: gift.model_path, audioPath: gift.audio_path, audioStatus: gift.audio_status, assetVersion: gift.asset_version, license: gift.license })) });
      }
      const { loadGifts } = require('../../../packages/gift-engine/src/catalog');
      const category = url.searchParams.get('category');
      const gifts = loadGifts().filter((gift) => !category || String(gift.category || '').toLowerCase().includes(category.toLowerCase()));
      return json(res, 200, { ok: true, count: gifts.length, gifts });
    }

    if (req.method === 'GET' && url.pathname === '/api/live/rooms') {
      const roomQuery = query({ select: 'id,host_id,title,category,state,is_private,started_at', state: 'eq.live', is_private: 'eq.false', order: 'started_at.desc.nullslast', limit: '24' });
      const rooms = await selectAdminRows(config, 'live_rooms', roomQuery);
      if (!rooms.ok) return json(res, 200, { ok: true, rooms: [], source: 'service-unavailable', unavailable: true });
      if (!rooms.rows.length) return json(res, 200, { ok: true, rooms: [], source: 'database' });
      const hosts = await selectAdminRows(config, 'profiles', query({ select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(rooms.rows.map((room) => room.host_id)) }));
      const hostById = new Map((hosts.rows || []).map((host) => [host.id, host]));
      return json(res, 200, { ok: true, source: 'database', rooms: rooms.rows.map((room) => safeRoom(room, hostById.get(room.host_id))) });
    }

    if (req.method === 'POST' && url.pathname === '/api/livekit/token') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const roomId = String(body.roomId || '');
      if (!uuid(roomId)) return error(res, 400, 'INVALID_ROOM_ID');
      const rooms = await selectAdminRows(config, 'live_rooms', query({ id: 'eq.' + roomId, select: 'id,host_id,state,is_private' }));
      if (!rooms.ok) return badDatabase(res, rooms);
      if (!rooms.rows.length) return error(res, 404, 'ROOM_NOT_FOUND');
      const room = rooms.rows[0];
      const currentId = session.profile.id;
      const host = room.host_id === currentId;
      const participantRows = await selectAdminRows(config, 'live_participants', query({
        room_id: 'eq.' + roomId, profile_id: 'eq.' + currentId, left_at: 'is.null', select: 'role'
      }));
      if (!participantRows.ok) return badDatabase(res, participantRows);
      const membership = participantRows.rows[0] || null;
      if (room.state === 'ended') return error(res, 409, 'ROOM_ENDED');
      if (room.is_private && !host && !membership) return error(res, 403, 'ROOM_ACCESS_DENIED');
      if (room.state !== 'live' && !host) return error(res, 409, 'ROOM_NOT_LIVE');
      const canPublish = host || Boolean(membership && membership.role === 'guest');
      if (canPublish && !host) {
        const active = await selectAdminRows(config, 'live_participants', query({ room_id: 'eq.' + roomId, left_at: 'is.null', select: 'profile_id,role' }));
        if (!active.ok) return badDatabase(res, active);
        const publishers = new Set(active.rows.filter((row) => row.role === 'host' || row.role === 'guest').map((row) => row.profile_id));
        publishers.add(room.host_id);
        if (publishers.size > 8) return error(res, 409, 'PUBLISHER_CAPACITY_EXCEEDED');
      }
      const ttlSeconds = Number.isInteger(body.ttlSeconds) ? Math.max(60, Math.min(3600, body.ttlSeconds)) : 900;
      const token = livekit.mintToken(config.livekit, { identity: currentId, room: room.id, canPublish, canSubscribe: true, ttlSeconds });
      return json(res, token.ok ? 200 : token.status || 500, token);
    }

    if (req.method === 'GET' && url.pathname === '/api/profile/me') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      return json(res, 200, { ok: true, profile: profileProjection(session.profile) });
    }

    if (req.method === 'PATCH' && url.pathname === '/api/profile/me') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const patch = {};
      for (const key of Object.keys(body)) {
        if (!PROFILE_FIELDS.has(key)) return error(res, 400, 'PROFILE_FIELD_NOT_ALLOWED');
        const value = body[key];
        if (key === 'visibility') {
          if (!['public','private','restricted'].includes(value)) return error(res, 400, 'INVALID_VISIBILITY');
        } else if (key === 'display_name') {
          if (typeof value !== 'string' || value.trim().length > 80) return error(res, 400, 'INVALID_DISPLAY_NAME');
          patch[key] = value.trim();
          continue;
        } else if (key === 'bio') {
          if (typeof value !== 'string' || value.length > 1000) return error(res, 400, 'INVALID_BIO');
          patch[key] = value;
          continue;
        } else if (key === 'avatar_url' || key === 'cover_url') {
          if (value !== null && !isValidHttpUrl(value)) return error(res, 400, 'INVALID_PROFILE_URL');
        }
        patch[key] = value;
      }
      if (!Object.keys(patch).length) return error(res, 400, 'EMPTY_PROFILE_UPDATE');
      patch.updated_at = new Date().toISOString();
      const result = await rowsForUser(session, 'profiles', { id: 'eq.' + session.profile.id, select: 'id,username,display_name,bio,avatar_url,cover_url,visibility,is_creator,is_verified,created_at,updated_at' }, { method: 'PATCH', body: patch });
      if (!result.ok) return badDatabase(res, result, 'PROFILE_UPDATE_FAILED');
      const saved = Array.isArray(result.data) ? result.data[0] : null;
      return json(res, 200, { ok: true, profile: profileProjection(saved || { ...session.profile, ...patch }) });
    }

    if (req.method === 'GET' && url.pathname === '/api/feed') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const mode = url.searchParams.get('mode') === 'following' ? 'following' : 'for-you';
      const limit = asSafeInt(url.searchParams.get('limit'), 20, 1, 40);
      let followedIds = [];
      const follows = await rowsForUser(session, 'follows', { select: 'followee_id', follower_id: 'eq.' + session.profile.id, limit: '300' });
      if (follows.ok && Array.isArray(follows.data)) followedIds = follows.data.map((row) => row.followee_id).filter(uuid);
      if (mode === 'following' && followedIds.length === 0) return json(res, 200, { ok: true, mode, posts: [] });
      const postParams = {
        select: 'id,author_id,kind,caption,media,audience,created_at,expires_at',
        deleted_at: 'is.null',
        order: 'created_at.desc',
        limit: String(mode === 'for-you' ? 100 : 100)
      };
      if (mode === 'following') postParams.author_id = profileIdIn(followedIds);
      const postResult = await rowsForUser(session, 'posts', postParams);
      if (!postResult.ok || !Array.isArray(postResult.data)) return badDatabase(res, postResult, 'FEED_UNAVAILABLE');
      let rows = postResult.data;
      if (mode === 'for-you') {
        const followed = new Set(followedIds);
        rows = rankCandidates(rows.map((post) => ({ ...post, authorId: post.author_id, visibility: post.audience, createdAt: post.created_at })), { viewerId: session.profile.id, followedProfileIds: followed })
          .slice(0, limit).map((entry) => ({ ...entry.candidate, rankingScore: entry.score }));
      } else rows = rows.slice(0, limit);
      const authors = [...new Set(rows.map((post) => post.author_id).filter(uuid))];
      let profileById = new Map();
      if (authors.length) {
        const profileRows = await rowsForUser(session, 'profiles', { select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(authors) });
        if (profileRows.ok && Array.isArray(profileRows.data)) profileById = new Map(profileRows.data.map((profile) => [profile.id, profile]));
      }
      const events = rows.map((post, index) => ({ profile_id: session.profile.id, content_type: 'post', content_id: post.id, event_type: 'impression', position: index }));
      if (events.length) await adminRest(config, 'recommendation_events', new URLSearchParams(), 'POST', events);
      return json(res, 200, { ok: true, mode, posts: rows.map((post) => ({
        id: post.id, kind: post.kind, caption: post.caption || '', media: Array.isArray(post.media) ? post.media : [],
        audience: post.audience, createdAt: post.created_at, expiresAt: post.expires_at || null,
        rankingScore: post.rankingScore ?? null,
        author: profileProjection(profileById.get(post.author_id))
      })) });
    }

    if (req.method === 'POST' && url.pathname === '/api/posts') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const kind = String(body.kind || '');
      const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
      const audience = body.audience || 'public';
      const assetIds = Array.isArray(body.mediaAssetIds) ? [...new Set(body.mediaAssetIds)] : [];
      if (!POST_KINDS.has(kind)) return error(res, 400, 'INVALID_POST_KIND');
      if (!AUDIENCES.has(audience)) return error(res, 400, 'INVALID_AUDIENCE');
      if (caption.length > 4000) return error(res, 400, 'CAPTION_TOO_LONG');
      if (kind === 'text' && !caption) return error(res, 400, 'TEXT_REQUIRED');
      if (assetIds.length > 10 || assetIds.some((id) => !uuid(id))) return error(res, 400, 'INVALID_MEDIA_ASSET_IDS');
      if (kind !== 'text' && assetIds.length === 0) return error(res, 400, 'MEDIA_ASSET_REQUIRED');
      let media = [];
      if (assetIds.length) {
        const assets = await rowsForUser(session, 'media_assets', {
          select: 'id,media_type,mime_type,storage_path,width,height,duration_ms,state',
          id: profileIdIn(assetIds), uploader_id: 'eq.' + session.profile.id, state: 'eq.ready', limit: '10'
        });
        if (!assets.ok || !Array.isArray(assets.data)) return badDatabase(res, assets, 'MEDIA_LOOKUP_FAILED');
        if (assets.data.length !== assetIds.length) return error(res, 409, 'MEDIA_NOT_READY');
        media = assets.data.map((asset) => ({ assetId: asset.id, mediaType: asset.media_type, mimeType: asset.mime_type, storagePath: asset.storage_path, width: asset.width, height: asset.height, durationMs: asset.duration_ms }));
      }
      const insert = await rowsForUser(session, 'posts', { select: 'id,author_id,kind,caption,media,audience,created_at,expires_at' }, {
        method: 'POST', body: { author_id: session.profile.id, kind, caption: caption || null, media, audience }
      });
      if (!insert.ok || !Array.isArray(insert.data) || !insert.data[0]) return badDatabase(res, insert, 'POST_PUBLISH_FAILED');
      const post = insert.data[0];
      if (assetIds.length) {
        await adminRest(config, 'media_assets', query({ id: profileIdIn(assetIds) }), 'PATCH', { post_id: post.id });
      }
      return json(res, 201, { ok: true, post: { id: post.id, kind: post.kind, caption: post.caption || '', media: post.media, audience: post.audience, createdAt: post.created_at } });
    }

    const reactionMatch = url.pathname.match(/^\/api\/posts\/([0-9a-f-]+)\/reactions$/i);
    if (reactionMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const postId = reactionMatch[1];
      if (!uuid(postId)) return error(res, 400, 'INVALID_POST_ID');
      const body = await readBody(req);
      const kind = ['like','love','laugh','wow','sad','celebrate'].includes(body.kind) ? body.kind : 'like';
      const result = await rowsForUser(session, 'reactions', { select: 'id,post_id,profile_id,kind,created_at' }, {
        method: 'POST', body: { post_id: postId, profile_id: session.profile.id, kind }
      });
      if (!result.ok) return badDatabase(res, result, 'REACTION_FAILED');
      return json(res, 201, { ok: true, reaction: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      if (!uuid(body.postId)) return error(res, 400, 'INVALID_POST_ID');
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 2000) return error(res, 400, 'INVALID_COMMENT');
      if (body.parentId && !uuid(body.parentId)) return error(res, 400, 'INVALID_PARENT_ID');
      const result = await rowsForUser(session, 'comments', { select: 'id,post_id,author_id,parent_id,body,created_at' }, {
        method: 'POST', body: { post_id: body.postId, author_id: session.profile.id, parent_id: body.parentId || null, body: body.body.trim() }
      });
      if (!result.ok) return badDatabase(res, result, 'COMMENT_FAILED');
      return json(res, 201, { ok: true, comment: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/follows') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      if (!uuid(body.profileId) || body.profileId === session.profile.id) return error(res, 400, 'INVALID_FOLLOW_TARGET');
      const result = await rowsForUser(session, 'follows', { select: 'follower_id,followee_id,created_at' }, {
        method: 'POST', body: { follower_id: session.profile.id, followee_id: body.profileId }
      });
      if (!result.ok) return badDatabase(res, result, 'FOLLOW_FAILED');
      return json(res, 201, { ok: true, follow: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/follows') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const targetId = url.searchParams.get('profileId');
      if (!uuid(targetId)) return error(res, 400, 'INVALID_FOLLOW_TARGET');
      const result = await rowsForUser(session, 'follows', { follower_id: 'eq.' + session.profile.id, followee_id: 'eq.' + targetId }, { method: 'DELETE' });
      if (!result.ok) return badDatabase(res, result, 'UNFOLLOW_FAILED');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at', order: 'created_at.desc', limit: '50' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'COMMUNITIES_UNAVAILABLE');
      return json(res, 200, { ok: true, communities: result.data });
    }

    if (req.method === 'POST' && url.pathname === '/api/communities') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const access = ['public','private','invite'].includes(body.access) ? body.access : 'public';
      if (name.length < 2 || name.length > 120) return error(res, 400, 'INVALID_COMMUNITY_NAME');
      const result = await rowsForUser(session, 'communities', { select: 'id,owner_id,name,access,created_at' }, { method: 'POST', body: { owner_id: session.profile.id, name, access } });
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res, result, 'COMMUNITY_CREATE_FAILED');
      return json(res, 201, { ok: true, community: result.data[0] });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'events', { select: 'id,host_id,title,description,starts_at,ends_at,tz,created_at', order: 'starts_at.asc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'EVENTS_UNAVAILABLE');
      return json(res, 200, { ok: true, events: result.data });
    }

    if (req.method === 'POST' && url.pathname === '/api/events') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const body = await readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const start = new Date(body.startsAt);
      const end = body.endsAt ? new Date(body.endsAt) : null;
      if (title.length < 2 || title.length > 180 || description.length > 4000 || !Number.isFinite(start.getTime()) || (end && (!Number.isFinite(end.getTime()) || end <= start))) return error(res, 400, 'INVALID_EVENT');
      const result = await rowsForUser(session, 'events', { select: 'id,host_id,title,description,starts_at,ends_at,tz,created_at' }, {
        method: 'POST', body: { host_id: session.profile.id, title, description: description || null, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null, tz: 'America/Jamaica' }
      });
      if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return badDatabase(res, result, 'EVENT_CREATE_FAILED');
      return json(res, 201, { ok: true, event: result.data[0] });
    }

    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const memberRows = await rowsForUser(session, 'conversation_members', { select: 'conversation_id,profile_id,role', profile_id: 'eq.' + session.profile.id, limit: '100' });
      if (!memberRows.ok || !Array.isArray(memberRows.data)) return badDatabase(res, memberRows, 'CONVERSATIONS_UNAVAILABLE');
      if (!memberRows.data.length) return json(res, 200, { ok: true, conversations: [] });
      const ids = [...new Set(memberRows.data.map((row) => row.conversation_id).filter(uuid))];
      const conversationRows = await rowsForUser(session, 'conversations', { select: 'id,is_group,created_at', id: profileIdIn(ids) });
      if (!conversationRows.ok || !Array.isArray(conversationRows.data)) return badDatabase(res, conversationRows, 'CONVERSATIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, conversations: conversationRows.data });
    }

    const messagesMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/i);
    if (messagesMatch && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const conversationId = messagesMatch[1];
      if (!uuid(conversationId)) return error(res, 400, 'INVALID_CONVERSATION_ID');
      const result = await rowsForUser(session, 'messages', { select: 'id,conversation_id,sender_id,body,attachments,created_at,edited_at,deleted_at', conversation_id: 'eq.' + conversationId, deleted_at: 'is.null', order: 'created_at.desc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'MESSAGES_UNAVAILABLE');
      return json(res, 200, { ok: true, messages: result.data.reverse() });
    }

    if (messagesMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const conversationId = messagesMatch[1];
      if (!uuid(conversationId)) return error(res, 400, 'INVALID_CONVERSATION_ID');
      const body = await readBody(req);
      if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.trim().length > 4000) return error(res, 400, 'INVALID_MESSAGE');
      const result = await rowsForUser(session, 'messages', { select: 'id,conversation_id,sender_id,body,attachments,created_at' }, {
        method: 'POST', body: { conversation_id: conversationId, sender_id: session.profile.id, body: body.body.trim(), attachments: [] }
      });
      if (!result.ok) return badDatabase(res, result, 'MESSAGE_SEND_FAILED');
      return json(res, 201, { ok: true, message: Array.isArray(result.data) ? result.data[0] : null });
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const result = await rowsForUser(session, 'notifications', { select: 'id,profile_id,kind,payload,read_at,created_at', profile_id: 'eq.' + session.profile.id, order: 'created_at.desc', limit: '100' });
      if (!result.ok || !Array.isArray(result.data)) return badDatabase(res, result, 'NOTIFICATIONS_UNAVAILABLE');
      return json(res, 200, { ok: true, notifications: result.data });
    }

    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);
    if (notificationReadMatch && req.method === 'POST') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const notificationId = notificationReadMatch[1];
      if (!uuid(notificationId)) return error(res, 400, 'INVALID_NOTIFICATION_ID');
      const result = await rowsForUser(session, 'notifications', { id: 'eq.' + notificationId, profile_id: 'eq.' + session.profile.id, select: 'id,read_at' }, { method: 'PATCH', body: { read_at: new Date().toISOString() } });
      if (!result.ok) return badDatabase(res, result, 'NOTIFICATION_UPDATE_FAILED');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      const accounts = await selectAdminRows(config, 'wallet_accounts', query({ select: 'id,kind', profile_id: 'eq.' + session.profile.id, kind: 'eq.user' }));
      if (!accounts.ok) return badDatabase(res, accounts, 'WALLET_UNAVAILABLE');
      if (!accounts.rows.length) return json(res, 200, { ok: true, wallet: { initialized: false, coinBalance: null, note: 'Wallet has not been provisioned for this account yet.' }, checkoutEnabled: false, payoutsEnabled: false });
      const postings = await selectAdminRows(config, 'ledger_postings', query({ select: 'delta,unit,entry_id', account_id: 'eq.' + accounts.rows[0].id, unit: 'eq.coins', limit: '5000' }));
      if (!postings.ok) return badDatabase(res, postings, 'WALLET_UNAVAILABLE');
      const balance = postings.rows.reduce((total, posting) => total + Number(posting.delta || 0), 0);
      return json(res, 200, { ok: true, wallet: { initialized: true, coinBalance: balance }, checkoutEnabled: false, payoutsEnabled: false });
    }

    if (req.method === 'GET' && url.pathname === '/api/rankings') {
      const periodRaw = url.searchParams.get('period') || 'monthly';
      const period = ['weekly','monthly','all_time'].includes(periodRaw) ? periodRaw : 'monthly';
      const scopeRaw = url.searchParams.get('scope') || 'global';
      const scope = ['global','country','creator','room','friends'].includes(scopeRaw) ? scopeRaw : 'global';
      const limit = asSafeInt(url.searchParams.get('limit'), 25, 1, 100);
      const start = period === 'monthly' ? monthlyPeriodStart(new Date()).toISOString() : period === 'weekly' ? weeklyPeriodStart(new Date()).toISOString() : null;
      const rankParams = query({ select: 'actor_id,coins,period_start,scope,period', scope: 'eq.' + scope, period: 'eq.' + (period === 'all_time' ? 'all_time' : period), ...(start ? { period_start: 'eq.' + start } : {}), order: 'coins.desc', limit: String(limit) });
      const ranked = await selectAdminRows(config, 'ranking_aggregates', rankParams);
      if (!ranked.ok) return badDatabase(res, ranked, 'RANKINGS_UNAVAILABLE');
      const actors = [...new Set(ranked.rows.map((row) => row.actor_id).filter(uuid))];
      const profiles = actors.length ? await selectAdminRows(config, 'profiles', query({ select: 'id,username,display_name,avatar_url,is_verified', id: profileIdIn(actors) })) : { ok: true, rows: [] };
      const profileMap = new Map(profiles.rows.map((p) => [p.id, p]));
      return json(res, 200, { ok: true, period, scope, rankings: ranked.rows.map((row, index) => {
        const profile = profileMap.get(row.actor_id);
        return { rank: index + 1, profile: profile ? { id: profile.id, username: profile.username, displayName: profile.display_name || profile.username, avatarUrl: profile.avatar_url || null, isVerified: Boolean(profile.is_verified) } : null, coins: Number(row.coins), periodStart: row.period_start };
      }) });
    }

    // Gift delivery and payment mutation stay disabled instead of using the in-memory demo ledger.
    if (req.method === 'POST' && url.pathname === '/api/gifts/send') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      return error(res, 503, 'PERSISTENT_GIFT_DELIVERY_NOT_READY', 'Gift delivery is disabled until the persistent database transaction and delivery record are connected. No wallet balance was changed.');
    }
    if (req.method === 'POST' && url.pathname === '/api/payments/order') {
      const session = await requireSession(req, res);
      if (!session.ok) return;
      return error(res, 503, 'PAYMENT_WORKFLOW_NOT_READY', 'Checkout is disabled until persistent order storage, capture verification, signed webhooks, idempotent coin credit, refunds and reconciliation are connected. No payment was created.');
    }

    return error(res, 404, 'NOT_FOUND');
  } catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return error(res, 413, 'PAYLOAD_TOO_LARGE');
    if (e.message === 'INVALID_JSON') return error(res, 400, 'INVALID_JSON');
    return error(res, 400, 'BAD_REQUEST', e.message);
  }
});

if (require.main === module) server.listen(config.apiPort, '0.0.0.0', () => console.log('ZUNO API listening on port ' + config.apiPort));
module.exports = { server, config };
