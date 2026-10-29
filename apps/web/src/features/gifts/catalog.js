import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';
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
let selectedGift = null;
let activeLiveRoomId = window.ZUNO_LIVE_GIFT_CONTEXT?.roomId || null;
let activeLiveRecipientUsername = window.ZUNO_LIVE_GIFT_CONTEXT?.hostUsername || '';
function giftSendStatus(message,isError=false) {
  const status=document.getElementById('gift-send-status');
  if(status){status.textContent=message;status.classList.toggle('is-error',Boolean(isError));}
}
function openGiftSendForm() {
  if(!getSession()) {
    giftSendStatus('Sign in before sending a gift.',true);
    document.getElementById('auth-state-button')?.click();
    return;
  }
  const form=document.getElementById('gift-send-form');
  if(!form||!selectedGift)return;
  form.hidden=false;
  document.getElementById('gift-send-id').value=selectedGift.id;
  document.getElementById('gift-send-live-room').value=activeLiveRoomId||'';
  const recipient=document.getElementById('gift-recipient-username');
  if(recipient && activeLiveRecipientUsername && !recipient.value)recipient.value=activeLiveRecipientUsername;
  document.getElementById('gift-recipient-username')?.focus();
}
function secureGiftKey() {
  if(window.crypto&&typeof window.crypto.randomUUID==='function')return window.crypto.randomUUID();
  if(window.crypto&&typeof window.crypto.getRandomValues==='function')return Array.from(window.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  return null;
}
async function submitGift(event) {
  event.preventDefault();
  if(!getSession()){document.getElementById('auth-state-button')?.click();giftSendStatus('Sign in before sending a gift.',true);return;}
  const username=document.getElementById('gift-recipient-username')?.value.trim().toLowerCase()||'';
  const message=document.getElementById('gift-send-message')?.value.trim()||'';
  const giftId=document.getElementById('gift-send-id')?.value||'';
  const liveRoomId=document.getElementById('gift-send-live-room')?.value||'';
  if(!/^[a-z0-9_.]{3,30}$/.test(username)){giftSendStatus('Enter the exact ZUNO username.',true);return;}
  const fingerprint=[giftId,username,liveRoomId,message].join('\u001f');
  let hash=2166136261;for(let i=0;i<fingerprint.length;i++){hash^=fingerprint.charCodeAt(i);hash=Math.imul(hash,16777619);}
  const storageKey='zuno:gift-idempotency:'+((hash>>>0).toString(16));
  let key=null;
  try { key=localStorage.getItem(storageKey); } catch (_) {}
  if(!key){key=secureGiftKey();if(key){try{localStorage.setItem(storageKey,key);}catch(_){}}}
  if(!key){giftSendStatus('Secure request IDs require an up-to-date browser over HTTPS.',true);return;}
  const button=document.getElementById('gift-send-submit');if(button)button.disabled=true;
  giftSendStatus('Checking the recipient and sending the gift…');
  try {
    const result=await requestJson('/api/gifts/send',{method:'POST',headers:{'Idempotency-Key':key},body:{recipientUsername:username,giftId,message,...(liveRoomId?{liveRoomId}:{})}});
    giftSendStatus('Gift delivered to @'+username+'. '+Number(result.delivery?.priceCoins||selectedGift?.priceCoins||0)+' Z Coins charged.');
    const note=document.getElementById('gift-inspect-note');if(note)note.textContent='Delivery confirmed by the ZUNO server.';
    try{localStorage.removeItem(storageKey);}catch(_){}
    window.dispatchEvent(new CustomEvent('zuno:wallet-refresh'));
  } catch(error) {
    const messageText=error.status===404?'No ZUNO account was found with that username.':error.code==='INSUFFICIENT_FUNDS'?'Your Z Coins balance is too low.':error.code==='GIFT_LOCKED'?'Your gifter level has not unlocked this gift yet.':(error.message||'Gift delivery could not be confirmed.');
    giftSendStatus(messageText,true);
  } finally {if(button)button.disabled=false;}
}

function showDetails(gift, group) {
  const dialog = document.getElementById('gift-dialog');
  const title = document.getElementById('gift-detail-title');
  const content = document.getElementById('gift-detail-content');
  if (!dialog || !content) return;
  selectedGift=gift;
  const sendForm=document.getElementById('gift-send-form');if(sendForm){sendForm.hidden=true;sendForm.reset();}
  if (title) title.textContent = gift.name || 'Gift';
  const audioPath=typeof gift.audioPath==='string'&&gift.audioPath.startsWith('assets/gift-audio/')&&!gift.audioPath.includes('..')?gift.audioPath:'';
  const audioPanel=gift.audioStatus==='resolved'&&audioPath?'<label class="gift-audio-preview-label" for="gift-audio-preview">Original gift sound</label><audio id="gift-audio-preview" class="gift-audio-preview" controls preload="none" aria-label="Play original gift sound"><source src="'+safeText(audioPath)+'" type="audio/wav"></audio>':'<p class="gift-audio-unresolved">'+safeText(gift.audioReason||'Distinct original sound has not yet been authored; no generic substitute is assigned.')+'</p>';
  content.innerHTML = '<div class="gift-detail-hero"><div class="gift-detail-glyph" aria-hidden="true">' + glyphs[group] + '</div><div><h3>' + safeText(gift.name) + '</h3><p>' + safeText(gift.categoryLabel || gift.category) + '</p></div></div><ul class="gift-detail-list">' +
    '<li><span>Stable gift ID</span><strong>' + safeText(gift.id) + '</strong></li>' +
    '<li><span>Catalogue price</span><strong>' + safeText(gift.priceCoins) + ' Z Coins</strong></li>' +
    '<li><span>Tier</span><strong>' + safeText(gift.tier) + '</strong></li>' +
    '<li><span>Audio status</span><strong>' + safeText(gift.audioStatus || 'not specified') + '</strong></li>' +
    '<li><span>Model asset</span><strong>' + safeText(gift.modelPath || 'Not specified') + '</strong></li></ul>' + audioPanel + '<button class="button button-primary button-small" id="gift-detail-send-open" type="button">Send this gift · ' + safeText(gift.priceCoins) + ' Z Coins</button>';
  content.querySelector('#gift-detail-send-open')?.addEventListener('click',openGiftSendForm);
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
  document.getElementById('gift-send-form')?.addEventListener('submit',submitGift);
  document.getElementById('gift-send-cancel')?.addEventListener('click',()=>{const form=document.getElementById('gift-send-form');if(form)form.hidden=true;});
  window.addEventListener('zuno:live-gift-context',event=>{
    activeLiveRoomId=typeof event.detail?.roomId==='string'?event.detail.roomId:null;
    activeLiveRecipientUsername=typeof event.detail?.hostUsername==='string'?event.detail.hostUsername:'';
    const liveInput=document.getElementById('gift-send-live-room');if(liveInput)liveInput.value=activeLiveRoomId||'';
  });
  const filters = document.getElementById('gift-filters');
  if (filters) filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gift-category]');
    if (!button) return;
    filters.querySelectorAll('.gift-filter').forEach((item) => item.classList.toggle('is-active', item === button));
    selectedCategory = button.dataset.giftCategory;
    render(true);
  });
}
