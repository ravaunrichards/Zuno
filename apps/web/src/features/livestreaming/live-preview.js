import { requestJson } from '../../services/api-client.js';
export async function mountLivePreview() {
  const status = document.getElementById('live-status');
  const note = document.getElementById('live-note');
  try {
    const result = await requestJson('/api/live/rooms');
    if (Array.isArray(result.rooms)) {
      const total = result.rooms.length;
      if (status) status.textContent = total ? total + ' rooms returned by service' : 'No active rooms returned';
      if (note) note.textContent = total ? 'Room data was returned from the API. A complete authenticated room experience is separate integration work.' : 'The connected service returned no active rooms.';
      return;
    }
  } catch (_) {}
  if (status) status.textContent = 'LIVE service not connected';
  if (note) note.textContent = 'No live room list is shown as real until a verified room service returns it.';
}
