import { requestJson } from '../../services/api-client.js';

export function mountComposer() {
  const dialog = document.getElementById('composer-dialog');
  const form = document.getElementById('composer-form');
  const textarea = document.getElementById('draft-text');
  const count = document.getElementById('draft-count');
  const status = document.getElementById('composer-status');
  const audience = document.getElementById('post-audience');
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
    try { localStorage.removeItem('zuno:local-draft'); } catch (_) {}
    if (status) status.textContent = 'Local draft cleared.';
    updateCount();
  }));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = textarea.value.trim();
    if (!value) { if (status) status.textContent = 'Write something before saving.'; return; }
    try {
      localStorage.setItem('zuno:local-draft', value);
      if (status) status.textContent = 'Draft saved on this device. It has not been published.';
    } catch (_) {
      if (status) status.textContent = 'This browser could not save the draft locally.';
    }
    updateCount();
  });

  document.querySelectorAll('[data-action="publish-post"]').forEach((button) => button.addEventListener('click', async () => {
    const value = textarea.value.trim();
    if (!value) { if (status) status.textContent = 'Write something before publishing.'; return; }
    button.disabled = true;
    if (status) status.textContent = 'Publishing through ZUNO…';
    try {
      const payload = await requestJson('/api/posts', {
        method: 'POST',
        body: { kind: 'text', caption: value, audience: audience ? audience.value : 'public' }
      });
      try { localStorage.removeItem('zuno:local-draft'); } catch (_) {}
      if (status) status.textContent = 'Published to ZUNO. Post ID: ' + payload.post.id;
      window.dispatchEvent(new CustomEvent('zuno:feed-refresh'));
    } catch (error) {
      if (status) status.textContent = error.status === 401
        ? 'Sign in to publish. You can still save a local draft.'
        : (error.message || 'Publishing failed. Your text is unchanged.');
    } finally {
      button.disabled = false;
    }
  }));
}
