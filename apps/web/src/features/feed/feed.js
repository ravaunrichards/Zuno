import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

const PAGE_SIZE = 12;
let mode = 'for-you';
let offset = 0;
let loading = false;
let exhausted = false;
let loadVersion = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Recently';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function statusMessage(message, isError = false) {
  const status = document.getElementById('feed-status');
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('is-error', isError);
}
function openAuth() {
  const trigger = document.getElementById('auth-state-button');
  if (trigger && !getSession()) trigger.click();
}
function mediaElement(post) {
  const wrap = element('div', 'feed-card-media');
  const first = Array.isArray(post.media) ? post.media[0] : null;
  if (first && first.url && first.mediaType === 'video') {
    const video = element('video', 'feed-media-player');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = first.url;
    video.setAttribute('aria-label', 'Post video');
    wrap.append(video);
  } else if (first && first.url && ['image', 'thumbnail'].includes(first.mediaType)) {
    const image = element('img', 'feed-media-image');
    image.src = first.url;
    image.alt = post.caption || 'Post media';
    image.loading = 'lazy';
    wrap.append(image);
  } else if (first && first.url && first.mediaType === 'audio') {
    const audio = element('audio', 'feed-media-audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = first.url;
    wrap.append(audio);
  } else {
    wrap.append(element('div', 'feed-media-unavailable',
      'Media was attached, but a safe viewer URL is not available until the signed-media endpoint is configured.'));
  }
  return wrap;
}
function renderPost(post) {
  const card = element('article', 'feed-card');
  const author = element('div', 'feed-card-author');
  const avatar = element('span', 'feed-author-avatar', post.author?.username?.slice(0, 1)?.toUpperCase() || 'Z');
  if (post.author?.avatarUrl) {
    const image = element('img', 'feed-author-image');
    image.src = post.author.avatarUrl;
    image.alt = '';
    image.loading = 'lazy';
    avatar.replaceChildren(image);
  }
  const authorCopy = element('div', 'feed-author-copy');
  authorCopy.append(element('strong', '', post.author?.displayName || 'ZUNO creator'));
  authorCopy.append(element('span', '', post.author?.username ? '@' + post.author.username : 'Profile unavailable'));
  author.append(avatar, authorCopy, element('time', 'feed-card-time', dateLabel(post.createdAt)));
  card.append(author, element('div', 'feed-post-type', String(post.kind || 'post').replace(/_/g, ' ').toUpperCase()));
  if (post.caption) card.append(element('p', 'feed-card-caption', post.caption));
  if (Array.isArray(post.media) && post.media.length) card.append(mediaElement(post));

  const actions = element('div', 'feed-card-actions');
  const like = element('button', 'feed-action', '♡ Like');
  like.type = 'button';
  like.addEventListener('click', async () => {
    if (!getSession()) {
      statusMessage('Sign in to react to posts.');
      openAuth();
      return;
    }
    like.disabled = true;
    try {
      await requestJson('/api/posts/' + encodeURIComponent(post.id) + '/reactions', { method: 'POST', body: { kind: 'like' } });
      like.textContent = '♥ Liked';
    } catch (error) {
      statusMessage(error.status === 409 ? 'This reaction already exists.' : (error.message || 'Could not react to this post.'), true);
    } finally {
      like.disabled = false;
    }
  });

  const comment = element('button', 'feed-action', 'Comment');
  comment.type = 'button';
  comment.addEventListener('click', async () => {
    if (!getSession()) {
      statusMessage('Sign in to comment on posts.');
      openAuth();
      return;
    }
    const body = window.prompt('Write a comment (up to 2,000 characters):');
    if (!body || !body.trim()) return;
    try {
      await requestJson('/api/comments', { method: 'POST', body: { postId: post.id, body: body.trim() } });
      statusMessage('Comment posted.');
    } catch (error) {
      statusMessage(error.message || 'Comment could not be posted.', true);
    }
  });
  actions.append(like, comment);
  card.append(actions);
  return card;
}

async function load(reset = false) {
  const grid = document.getElementById('feed-grid');
  const more = document.getElementById('feed-load-more');
  if (!grid || loading) return;
  const version = ++loadVersion;
  if (reset) {
    offset = 0;
    exhausted = false;
    grid.replaceChildren();
  }
  if (!getSession()) {
    grid.replaceChildren();
    statusMessage('Sign in to load posts from your authenticated ZUNO feed.');
    if (more) more.hidden = true;
    return;
  }
  loading = true;
  if (more) { more.disabled = true; more.textContent = 'Loading…'; }
  statusMessage(offset === 0 ? 'Loading posts from ZUNO…' : 'Loading more posts…');
  try {
    const payload = await requestJson('/api/feed?mode=' + encodeURIComponent(mode) + '&limit=' + PAGE_SIZE + '&offset=' + offset);
    if (version !== loadVersion) return;
    const posts = Array.isArray(payload.posts) ? payload.posts : [];
    posts.forEach((post) => grid.append(renderPost(post)));
    offset += posts.length;
    exhausted = posts.length < PAGE_SIZE;
    statusMessage(posts.length ? 'Loaded ' + offset + ' posts.' :
      (offset === 0 && mode === 'following' ? 'No posts from followed creators yet. Explore and follow creators to build this feed.' :
        offset === 0 ? 'No visible posts have been published to your feed yet.' : 'You are all caught up.'));
    if (more) { more.hidden = exhausted; more.disabled = false; more.textContent = 'Load more posts'; }
  } catch (error) {
    statusMessage(error.status === 401 ? 'Sign in to view your feed.' : (error.message || 'Feed data is temporarily unavailable.'), true);
    if (more) { more.disabled = false; more.hidden = true; more.textContent = 'Load more posts'; }
  } finally {
    loading = false;
  }
}

export function mountFeed() {
  const modeButtons = Array.from(document.querySelectorAll('[data-feed-mode]'));
  modeButtons.forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.feedMode === 'following' ? 'following' : 'for-you';
    modeButtons.forEach((item) => item.classList.toggle('is-active', item === button));
    load(true);
  }));
  document.getElementById('feed-refresh')?.addEventListener('click', () => load(true));
  document.getElementById('feed-load-more')?.addEventListener('click', () => { if (!exhausted) load(false); });
  window.addEventListener('zuno:session-change', () => load(true));
  window.addEventListener('zuno:feed-refresh', () => load(true));
  load(true);
}
