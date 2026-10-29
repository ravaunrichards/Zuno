'use strict';
const output = document.getElementById('health-output');
const button = document.getElementById('check-health');
if (button) button.addEventListener('click', async () => {
  button.disabled = true; button.textContent = 'Checking…';
  if (output) output.textContent = '';
  try {
    const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'http://localhost:4000' : '';
    const response = await fetch(base + '/health', { headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error('API returned ' + response.status);
    if (output) output.textContent = 'Public health endpoint responded: ' + body.status + '. This does not authorize admin actions or prove data services are configured.';
  } catch (_) {
    if (output) output.textContent = 'Public API health could not be retrieved from this origin. No admin data has been loaded.';
  } finally { button.disabled = false; button.textContent = 'Check public API health'; }
});
