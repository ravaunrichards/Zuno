import { requestJson } from '../../services/api-client.js';

import { uploadAndProcess } from './media-upload.js';

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
