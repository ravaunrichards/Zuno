import { requestJson } from '../../services/api-client.js';
import { mountGiftPreviews } from './preview3d.js';
const PAGE_SIZE = 12;
const glyphs = { flowers:'✿', celebration:'✦', cosmic:'✧', jamaica:'♬', vehicles:'➤', luxury:'◇', animals:'♧', music:'♫', creator_support:'♡', seasonal:'❋', premium:'✺' };
function safeText(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function family(category) {
  const text = String(category || '').toLowerCase();
  if (text.includes('flower') || text.includes('romance')) return 'flowers';
  if (text.includes('celebration')) return 'celebration';
  if (text.includes('cosmic')) return 'cosmic';
  if (text.includes('jamaica')) return 'jamaica';
  if (text.includes('vehicle')) return 'vehicles';
  if (text.includes('luxury')) return 'luxury';
  if (text.includes('animal')) return 'animals';
  if (text.includes('music')) return 'music';
  if (text.includes('creator')) return 'creator_support';
  if (text.includes('seasonal')) return 'seasonal';
  return 'premium';
}
function showDetails(gift, group) {
  const dialog = document.getElementById('gift-dialog');
  const title = document.getElementById('gift-detail-title');
  const content = document.getElementById('gift-detail-content');
  if (!dialog || !content) return;
  if (title) title.textContent = gift.name || 'Gift';
  content.innerHTML = '<div class="gift-detail-hero"><div class="gift-detail-glyph" aria-hidden="true">' + glyphs[group] + '</div><div><h3>' + safeText(gift.name) + '</h3><p>' + safeText(gift.categoryLabel || gift.category) + '</p></div></div><ul class="gift-detail-list">' +
    '<li><span>Stable gift ID</span><strong>' + safeText(gift.id) + '</strong></li>' +
    '<li><span>Catalogue price</span><strong>' + safeText(gift.priceCoins) + ' Z Coins</strong></li>' +
    '<li><span>Tier</span><strong>' + safeText(gift.tier) + '</strong></li>' +
    '<li><span>Audio status</span><strong>' + safeText(gift.audioStatus || 'not specified') + '</strong></li>' +
    '<li><span>Model asset</span><strong>' + safeText(gift.modelPath || 'Not specified') + '</strong></li></ul>';
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
}
function createCard(gift) {
  const group = family(gift.category);
  const el = document.createElement('article');
  el.className = 'gift-card';
  el.dataset.category = group;
  el.innerHTML = '<div class="gift-visual" role="img" aria-label="' + safeText(gift.name) + ' preview"><span class="gift-glyph" aria-hidden="true">' + glyphs[group] + '</span></div><div class="gift-name">' + safeText(gift.name) + '</div><div class="gift-meta"><span class="gift-price">◇ ' + safeText(gift.priceCoins) + '</span><span class="gift-tier">Tier ' + safeText(gift.tier) + '</span></div><button class="gift-inspect" type="button">Inspect gift</button>';
  el.querySelector('button').addEventListener('click', () => showDetails(gift, group));
  return el;
}
export async function mountGiftCatalog() {
  const grid = document.getElementById('gift-grid');
  const count = document.getElementById('gift-count');
  const source = document.getElementById('gift-source');
  if (!grid) return;
  let gifts = [];
  let dataSource = 'Bundled catalogue';
  try { const response = await requestJson('/api/catalog/gifts'); if (Array.isArray(response.gifts) && response.gifts.length) { gifts = response.gifts; dataSource = 'API catalogue'; } } catch (_) {}
  if (!gifts.length) {
    try { const response = await fetch('./gifts.json'); if (!response.ok) throw new Error('catalog unavailable'); const parsed = await response.json(); if (!Array.isArray(parsed)) throw new Error('catalog format invalid'); gifts = parsed; }
    catch (_) { grid.innerHTML = '<div class="catalog-loading">Gift catalogue is unavailable. Check the bundled manifest and asset validation.</div>'; if (count) count.textContent = 'Unavailable'; if (source) source.textContent = 'Source unavailable'; return; }
  }
  if (count) count.textContent = gifts.length + ' catalogue items';
  if (source) source.textContent = dataSource;
  const previewRenderer = mountGiftPreviews(grid);
  let selectedCategory = 'all';
  let shown = 0;
  const loadMore = document.getElementById('gift-load-more');
  const matchingGifts = () => selectedCategory === 'all' ? gifts : gifts.filter((gift) => family(gift.category) === selectedCategory);
  function render(reset = false) {
    if (reset) { grid.replaceChildren(); shown = 0; }
    const matching = matchingGifts();
    matching.slice(shown, shown + PAGE_SIZE).forEach((gift) => { const card = createCard(gift); card.dataset.giftId = gift.id; card.dataset.giftName = gift.name; card.dataset.modelPath = gift.modelPath || ''; grid.appendChild(card); });
    previewRenderer.refresh();
    shown = Math.min(matching.length, shown + PAGE_SIZE);
    if (!matching.length) grid.innerHTML = '<div class="catalog-loading">No gifts in this category.</div>';
    if (count) count.textContent = matching.length + ' gifts in this category';
    if (loadMore) {
      loadMore.hidden = shown >= matching.length;
      loadMore.textContent = 'Load more gifts (' + Math.max(0, matching.length - shown) + ' remaining)';
    }
  }
  render(true);
  if (loadMore) loadMore.addEventListener('click', () => render(false));
  const filters = document.getElementById('gift-filters');
  if (filters) filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gift-category]');
    if (!button) return;
    filters.querySelectorAll('.gift-filter').forEach((item) => item.classList.toggle('is-active', item === button));
    selectedCategory = button.dataset.giftCategory;
    render(true);
  });
}
