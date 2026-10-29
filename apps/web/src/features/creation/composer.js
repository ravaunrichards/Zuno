import { requestJson } from '../../services/api-client.js';

const MAX_PROCESSING_WAIT_MS = 180000;
const PROCESSING_POLL_MS = 2500;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function mediaTypeFor(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}
async function uploadAndProcess(file, status) {
  const mediaType = mediaTypeFor(file);
  if (!mediaType) throw new Error('Choose a supported photo, video or audio file.');
  if (status) status.textContent = 'Requesting a secure upload URL…';
  const urlData = await requestJson('/api/media/upload-url', {
    method: 'POST',
    body: { mediaType, mimeType: file.type, byteSize: file.size, filename: file.name }
  });
  if (!urlData.upload || !urlData.upload.url || !urlData.asset || !urlData.asset.id) throw new Error('The media upload URL response was incomplete.');
  if (status) status.textContent = 'Uploading ' + file.name + '…';
  const response = await fetch(urlData.upload.url, {
    method: urlData.upload.method || 'PUT',
    headers: urlData.upload.headers || { 'Content-Type': file.type },
    body: file,
    credentials: 'omit'
  });
  if (!response.ok) throw new Error('Private media upload failed (HTTP ' + response.status + ').');
  if (status) status.textContent = 'Verifying upload and queueing safe media processing…';
  await requestJson('/api/media/' + encodeURIComponent(urlData.asset.id) + '/complete', { method: 'POST', body: {} });
  const deadline = Date.now() + MAX_PROCESSING_WAIT_MS;
  let lastState = 'processing';
  while (Date.now() < deadline) {
    const result = await requestJson('/api/media/' + encodeURIComponent(urlData.asset.id));
    lastState = result.asset && result.asset.state || 'unknown';
    if (lastState === 'ready') return { assetId: urlData.asset.id, mediaType };
    if (lastState === 'failed' || lastState === 'quarantined' || lastState === 'deleted') {
      throw new Error('Media processing ended with state "' + lastState + '". The file was not published.');
    }
    if (status) status.textContent = 'Server processing media (' + lastState + ')…';
    await sleep(PROCESSING_POLL_MS);
  }
  throw new Error('Media is still processing on the server. It was uploaded but not published. Check Media status before retrying.');
}

export function mountComposer() {
  const dialog = document.getElementById('composer-dialog');
  const form = document.getElementById('composer-form');
  const textarea = document.getElementById('draft-text');
  const count = document.getElementById('draft-count');
  const status = document.getElementById('composer-status');
  const audience = document.getElementById('post-audience');
  const fileInput = document.getElementById('media-file');
  if (!dialog || !form || !textarea) return;

  try { textarea.value = localStorage.getItem('zuno:local-draft') || ''; } catch (_) {}
  function updateCount() { if (count) count.textContent = textarea.value.length + ' / 4000'; }
  updateCount();
  textarea.addEventListener('input', updateCount);

  document.querySelectorAll('[data-action="compose"]').forEach((button) => button.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    updateCount();
  }));

  document.querySelectorAll('[data-action="clear-draft"]').forEach((button) => button.addEventListener('click', () => {
    textarea.value = '';
    if (fileInput) fileInput.value = '';
    try { localStorage.removeItem('zuno:local-draft'); } catch (_) {}
    if (status) status.textContent = 'Local draft cleared. A selected file was not uploaded.';
    updateCount();
  }));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = textarea.value.trim();
    if (!value) { if (status) status.textContent = 'Write a caption or select media before saving.'; return; }
    try {
      localStorage.setItem('zuno:local-draft', value);
      if (status) status.textContent = 'Draft saved on this device. It has not been published. The selected file was not uploaded.';
    } catch (_) {
      if (status) status.textContent = 'This browser could not save the draft locally.';
    }
    updateCount();
  });

  document.querySelectorAll('[data-action="publish-post"]').forEach((button) => button.addEventListener('click', async () => {
    const caption = textarea.value.trim();
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    if (!caption && !file) { if (status) status.textContent = 'Write a caption or choose media before publishing.'; return; }
    button.disabled = true;
    try {
      let body;
      if (file) {
        const processed = await uploadAndProcess(file, status);
        const kind = processed.mediaType === 'image' ? 'photo' : processed.mediaType === 'video' ? 'short_video' : 'audio';
        if (status) status.textContent = 'Publishing processed media…';
        body = { kind, caption, audience: audience ? audience.value : 'public', mediaAssetIds: [processed.assetId] };
      } else {
        if (status) status.textContent = 'Publishing text to ZUNO…';
        body = { kind: 'text', caption, audience: audience ? audience.value : 'public' };
      }
      const payload = await requestJson('/api/posts', { method: 'POST', body });
      try { localStorage.removeItem('zuno:local-draft'); } catch (_) {}
      textarea.value = '';
      if (fileInput) fileInput.value = '';
      updateCount();
      if (status) status.textContent = 'Published to ZUNO. Post ID: ' + payload.post.id;
      window.dispatchEvent(new CustomEvent('zuno:feed-refresh'));
    } catch (error) {
      if (status) status.textContent = error.status === 401
        ? 'Sign in to publish. Your local draft remains available.'
        : (error.message || 'Publishing failed. Text and selected media were not marked as published.');
    } finally {
      button.disabled = false;
    }
  }));
}
