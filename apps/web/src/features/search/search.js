import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

export function mountSearch() {
  const form = document.getElementById('site-search');
  const input = document.getElementById('search-input');
  const results = document.getElementById('global-search-results');
  const body = document.getElementById('search-results-body');
  const title = document.getElementById('search-results-title');
  const close = document.getElementById('close-search-results');
  const topics = Array.from(document.querySelectorAll('[data-searchable]'));
  const empty = document.getElementById('filter-empty');
  if (!form || !input) return;
  let busy = false;
  function applyLocalFilter() {
    const query = input.value.trim().toLowerCase();
    let shown = 0;
    topics.forEach((card) => {
      const haystack = (card.dataset.searchable || '') + ' ' + card.textContent;
      const match = !query || haystack.toLowerCase().includes(query);
      card.hidden = !match;
      if (match) shown += 1;
    });
    if (empty) empty.hidden = shown > 0;
  }
  function showPanel(message, error = false) {
    if (results) results.hidden = false;
    if (!body) return;
    body.replaceChildren();
    const node = document.createElement('p');
    node.className = error ? 'search-error' : 'search-empty';
    node.textContent = message;
    body.append(node);
  }
  function resultButton(label, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result-action';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }
  function resultCard(type, heading, detail, actions = []) {
    const card = document.createElement('article');
    card.className = 'search-result-card';
    const titleNode = document.createElement('strong');
    titleNode.textContent = heading;
    card.append(titleNode);
    if (detail) {
      const p = document.createElement('p');
      p.textContent = detail;
      card.append(p);
    }
    if (actions.length) {
      const controls = document.createElement('div');
      controls.className = 'search-result-actions';
      actions.forEach(control => controls.append(control));
      card.append(controls);
    }
    return card;
  }
  async function executeSearch(event) {
    if (event) event.preventDefault();
    const query = input.value.trim();
    if (query.length < 2) { showPanel('Enter at least two characters to search ZUNO.', true); return; }
    if (!getSession()) {
      showPanel('Sign in to search creators, posts, communities and events using your account permissions.');
      document.getElementById('auth-state-button')?.click();
      return;
    }
    if (busy) return;
    busy = true;
    showPanel('Searching ZUNO data…');
    if (title) title.textContent = 'Searching';
    try {
      const result = await requestJson('/api/search?q=' + encodeURIComponent(query) + '&type=all');
      if (title) title.textContent = 'Results for “' + query + '”';
      if (!body) return;
      body.replaceChildren();
      let count = 0;
      const groups = result.results || {};
      const sections = [
        ['Creators', groups.profiles || []],
        ['Posts', groups.posts || []],
        ['Communities', groups.communities || []],
        ['Events', groups.events || []]
      ];
      for (const [label, items] of sections) {
        if (!items.length) continue;
        const section = document.createElement('section');
        section.className = 'search-result-group';
        const h = document.createElement('h3');
        h.textContent = label;
        section.append(h);
        items.forEach(item => {
          count++;
          if (label === 'Creators') {
            const card = resultCard('profile', (item.displayName || item.username || 'Creator') + (item.isVerified ? ' ✓' : ''),
              '@' + item.username, [
                resultButton('Follow', async () => {
                  try {
                    await requestJson('/api/follows', { method: 'POST', body: { profileId: item.id } });
                    showPanel('Followed @' + item.username + '.');
                  } catch (error) {
                    showPanel(error.message || 'Follow request failed.', true);
                  }
                }),
                resultButton('Message', () => {
                  results.hidden = true;
                  window.dispatchEvent(new CustomEvent('zuno:profile-message', { detail: { profileId: item.id, username: item.username, displayName: item.displayName } }));
                }),
                resultButton('View memberships', () => {
                  results.hidden = true;
                  window.dispatchEvent(new CustomEvent('zuno:view-creator-tiers', { detail: {
                    id: item.id, username: item.username, displayName: item.displayName
                  }}));
                })
              ]);
            section.append(card);
          } else if (label === 'Posts') {
            section.append(resultCard('post', item.author?.displayName || 'ZUNO member',
              (item.caption || '').slice(0, 360) + ' · ' + new Date(item.createdAt).toLocaleString(),
              [resultButton('Open feed', () => {
                results.hidden = true;
                document.getElementById('feed')?.scrollIntoView({ behavior: 'smooth' });
              })]));
          } else if (label === 'Communities') {
            const actions = [];
            if (item.access === 'public') actions.push(resultButton('Join community', async () => {
              try {
                await requestJson('/api/communities/' + encodeURIComponent(item.id) + '/join', { method: 'POST', body: {} });
                showPanel('Joined ' + item.name + '.');
              } catch (error) { showPanel(error.message || 'Community join failed.', true); }
            }));
            section.append(resultCard(item.name, item.owner?.username ? 'Owned by @' + item.owner.username : 'ZUNO community', '', actions));
          } else {
            section.append(resultCard(item.title, (item.description || 'Event') + ' · ' + new Date(item.startsAt).toLocaleString(),
              item.host?.username ? 'Hosted by @' + item.host.username : 'Hosted on ZUNO',
              [resultButton('RSVP going', async () => {
                try {
                  await requestJson('/api/events/' + encodeURIComponent(item.id) + '/rsvp', { method: 'POST', body: { response: 'going' } });
                  showPanel('RSVP saved for ' + item.title + '.');
                } catch (error) { showPanel(error.message || 'RSVP failed.', true); }
              })]));
          }
        });
        body.append(section);
      }
      if (!count) showPanel(result.partial ? 'No matches. Some search sources were unavailable.' : 'No matching creators, posts, communities or events were found.');
      else if (result.partial) {
        const note = document.createElement('p');
        note.className = 'search-note';
        note.textContent = 'Some result categories were unavailable: ' + (result.unavailableTypes || []).join(', ');
        body.append(note);
      }
    } catch (error) {
      showPanel(error.status === 401 ? 'Sign in to search.' : (error.message || 'Search is unavailable.'), true);
    } finally { busy = false; }
  }
  input.addEventListener('input', applyLocalFilter);
  form.addEventListener('submit', executeSearch);
  input.addEventListener('keydown', event => {
    if (event.key === '/') { event.preventDefault(); input.focus(); }
    if (event.key === 'Escape' && results) results.hidden = true;
  });
  close?.addEventListener('click', () => { if (results) results.hidden = true; });
  applyLocalFilter();
}
