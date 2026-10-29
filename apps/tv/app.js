'use strict';
import { mountProductLinks } from '../web/src/components/product-links.js';
mountProductLinks();
const cards = Array.from(document.querySelectorAll('.tv-card'));
function focusCard(index) {
  if (!cards.length) return;
  const next = (index + cards.length) % cards.length;
  cards.forEach((card, i) => card.classList.toggle('selected', i === next));
  cards[next].focus({ preventScroll: true });
  cards[next].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  current = next;
}
let current = 0;
document.addEventListener('keydown', (event) => {
  const columns = matchMedia('(max-width: 680px)').matches ? 2 : matchMedia('(max-width: 1100px)').matches ? 3 : 5;
  if (event.key === 'ArrowRight') { event.preventDefault(); focusCard(current + 1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); focusCard(current - 1); }
  if (event.key === 'ArrowDown') { event.preventDefault(); focusCard(current + columns); }
  if (event.key === 'ArrowUp') { event.preventDefault(); focusCard(current - columns); }
});
cards.forEach((card, i) => card.addEventListener('focus', () => { current = i; cards.forEach((item, n) => item.classList.toggle('selected', n === i)); }));
