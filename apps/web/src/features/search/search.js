export function mountSearch() {
  const form = document.getElementById('site-search');
  const input = document.getElementById('search-input');
  const topics = Array.from(document.querySelectorAll('[data-searchable]'));
  const empty = document.getElementById('filter-empty');
  if (!form || !input) return;
  function apply() {
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
  input.addEventListener('input', apply);
  form.addEventListener('submit', (event) => { event.preventDefault(); document.getElementById('discover').scrollIntoView({ behavior: 'smooth' }); apply(); });
}
