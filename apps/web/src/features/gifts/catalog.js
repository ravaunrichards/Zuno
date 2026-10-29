import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';
import { giftArtwork, giftFamily } from './artwork.js';
const PAGE_SIZE = 12;
function safeText(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function family(category) { return giftFamily({ category }); }
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
  content.innerHTML = '<div class="gift-detail-hero"><div class="gift-detail-art">' + giftArtwork(gift) + '</div><div><h3>' + safeText(gift.name) + '</h3><p>' + safeText(gift.categoryLabel || gift.category) + '</p></div></div><ul class="gift-detail-list">' +
    '<li><span>Stable gift ID</span><strong>' + safeText(gift.id || gift.giftId) + '</strong></li>' +
    '<li><span>Catalogue price</span><strong>' + safeText(Number(gift.priceCoins).toLocaleString()) + ' Z Coins</strong></li>' +
    '<li><span>Tier</span><strong>' + safeText(gift.tier == null ? 'Standard' : gift.tier) + '</strong></li>' +
    '<li><span>Audio status</span><strong>' + safeText(gift.audioStatus || 'not specified') + '</strong></li>' +
    '<li><span>Model asset</span><strong>' + safeText(gift.modelPath || 'Not specified') + '</strong></li></ul>' + audioPanel + '<button class="button button-primary button-small" id="gift-detail-send-open" type="button">Send this gift · ' + safeText(Number(gift.priceCoins).toLocaleString()) + ' Z Coins</button>';
  content.querySelector('#gift-detail-send-open')?.addEventListener('click',openGiftSendForm);
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
}
function createCard(gift) {
  const el = document.createElement('article');
  el.className = 'gift-card';
  el.dataset.category = family(gift.category);
  el.innerHTML = '<div class="gift-visual">' + giftArtwork(gift) + '</div><div class="gift-name">' + safeText(gift.name) + '</div><div class="gift-meta"><span class="gift-price">◇ ' + safeText(Number(gift.priceCoins).toLocaleString()) + '</span><span class="gift-tier">Tier ' + safeText(gift.tier == null ? 'Standard' : gift.tier) + '</span></div><button class="gift-inspect" type="button">View gift</button>';
  el.querySelector('button').addEventListener('click', () => showDetails(gift, family(gift.category)));
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
    try { const response = await fetch('./gifts.json'); if (!response.ok) throw new Error('catalog unavailable'); const parsed = await response.json(); const records = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.gifts) ? parsed.gifts : null); if (!records) throw new Error('catalog format invalid'); gifts = records; }
    catch (_) { grid.innerHTML = '<div class="catalog-loading">Gift catalogue is unavailable. Check the bundled manifest and asset validation.</div>'; if (count) count.textContent = 'Unavailable'; if (source) source.textContent = 'Source unavailable'; return; }
  }
  gifts = gifts.map((gift) => ({ ...gift, id: gift.id || gift.giftId, tier: gift.tier == null ? 'Standard' : gift.tier })).filter((gift) => gift && gift.id && gift.name && Number.isFinite(Number(gift.priceCoins)) && Number(gift.priceCoins) > 0);
  if (!gifts.length) { grid.innerHTML = '<div class="catalog-loading">The catalogue loaded, but it contains no valid gift entries.</div>'; if (count) count.textContent = 'No gifts'; if (source) source.textContent = 'Catalogue invalid'; return; }
  if (count) count.textContent = gifts.length + ' catalogue items';
  if (source) source.textContent = dataSource;
  let selectedCategory = 'all';
  let shown = 0;
  const loadMore = document.getElementById('gift-load-more');
  const matchingGifts = () => selectedCategory === 'all' ? gifts : gifts.filter((gift) => family(gift.category) === selectedCategory);
  function render(reset = false) {
    if (reset) { grid.replaceChildren(); shown = 0; }
    const matching = matchingGifts();
    matching.slice(shown, shown + PAGE_SIZE).forEach((gift) => { const card = createCard(gift); card.dataset.giftId = gift.id; card.dataset.giftName = gift.name; card.dataset.modelPath = gift.modelPath || ''; grid.appendChild(card); });
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
  window.addEventListener('zuno:live-open-gift-picker',event=>{
    const roomId=typeof event.detail?.roomId==='string'?event.detail.roomId:'';
    if(!roomId)return;
    activeLiveRoomId=roomId;
    activeLiveRecipientUsername=typeof event.detail?.hostUsername==='string'?event.detail.hostUsername:'';
    const dialog=document.getElementById('gift-dialog');
    const title=document.getElementById('gift-detail-title');
    const content=document.getElementById('gift-detail-content');
    const form=document.getElementById('gift-send-form');
    if(!dialog||!content)return;
    selectedGift=null;
    if(form){form.hidden=true;form.reset();}
    if(title)title.textContent='Choose a LIVE gift';
    content.replaceChildren();
    const intro=document.createElement('p');
    intro.className='fine-print';
    intro.textContent=activeLiveRecipientUsername
      ?'Choose a gift to send to @'+activeLiveRecipientUsername+'. The server will confirm the current room and charge only the catalogue price.'
      :'Choose a gift and enter the recipient username. The server will verify room membership and wallet balance.';
    content.append(intro);
    const picker=document.createElement('div');
    picker.className='live-gift-picker-grid';
    matchingGifts().forEach(gift=>{
      const button=document.createElement('button');
      button.type='button';
      button.className='live-gift-picker-item';
      const art=document.createElement('span');art.className='live-gift-picker-art';art.innerHTML=giftArtwork(gift,true);
      const name=document.createElement('strong');name.textContent=gift.name;
      const price=document.createElement('span');price.className='live-gift-picker-price';price.textContent=Number(gift.priceCoins).toLocaleString()+' Z Coins';
      button.append(art,name,price);
      button.addEventListener('click',()=>showDetails(gift,family(gift.category)));
      picker.append(button);
    });
    content.append(picker);
    if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.setAttribute('open','');
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
