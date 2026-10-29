import { requestJson } from '../../services/api-client.js';
import { getSession } from '../auth/session.js';

const cart=new Map();
let listings=[];
let busy=false;
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function id(value){return document.getElementById(value);}
function money(minor,currency='USD'){return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(Number(minor)/100);}
function makeKey(){return window.crypto?.randomUUID?.() || (window.crypto?.getRandomValues ? Array.from(window.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('') : null);}
function status(message,isError=false){const box=id('marketplace-status');if(box){box.textContent=message;box.classList.toggle('is-error',isError);}}
function requireAuth(){if(getSession())return true;status('Sign in to browse, list items or checkout.',true);id('auth-state-button')?.click();return false;}
function renderListing(item){
 const card=el('article','marketplace-listing-card');
 const art=el('div','marketplace-listing-art','◇');card.append(art);
 const meta=el('div','marketplace-listing-meta');meta.append(el('span','',item.category||'Marketplace'),el('span','',Number(item.availableQuantity)+' available'));
 card.append(meta,el('h3','',item.title),el('p','marketplace-listing-description',item.description||'No description provided.'));
 const seller=el('p','marketplace-listing-seller',item.seller?.username?'Seller @'+item.seller.username:'ZUNO seller');
 const price=el('strong','marketplace-listing-price',money(item.priceMinor,item.currency));
 const actions=el('div','marketplace-listing-actions');
 const qty=document.createElement('input');qty.type='number';qty.min='1';qty.max=String(Math.min(100,Number(item.availableQuantity)||1));qty.value='1';qty.className='marketplace-quantity';qty.setAttribute('aria-label','Quantity for '+item.title);
 const button=el('button','button button-primary button-small','Add to cart');button.type='button';button.disabled=Number(item.availableQuantity)<=0;
 button.addEventListener('click',()=>{
  const quantity=Number(qty.value);
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>Number(item.availableQuantity)){status('Choose a quantity available in stock.',true);return;}
  cart.set(item.id,{listingId:item.id,title:item.title,priceMinor:Number(item.priceMinor),currency:item.currency,quantity,available:Number(item.availableQuantity)});
  renderCart();status(item.title+' added to your cart.');
 });
 actions.append(qty,button);card.append(seller,price,actions);return card;
}
async function loadListings(){
 const list=id('marketplace-listings');if(!list)return;
 if(!getSession()){list.replaceChildren(el('p','marketplace-empty','Sign in to browse listings returned from the live marketplace database.'));status('Sign in to browse marketplace listings.');return;}
 list.replaceChildren(el('p','marketplace-empty','Loading active listings…'));
 const q=id('marketplace-query')?.value.trim()||'';
 try{
  const result=await requestJson('/api/marketplace/listings?limit=30'+(q?'&q='+encodeURIComponent(q):''));
  listings=Array.isArray(result.listings)?result.listings:[];
  list.replaceChildren();
  if(!listings.length)list.append(el('p','marketplace-empty','No active listings matched this query. Sellers can publish a draft once they have available stock.'));
  listings.forEach(item=>list.append(renderListing(item)));
  status(listings.length+' active listing(s) loaded from ZUNO.');
 }catch(error){list.replaceChildren(el('p','marketplace-empty',error.message||'Marketplace listings are unavailable.'));status(error.message||'Marketplace unavailable.',true);}
}
function renderCart(){
 const box=id('marketplace-cart-items');const summary=id('marketplace-cart-summary');if(!box)return;
 box.replaceChildren();
 const items=[...cart.values()];
 let total=0;let count=0;
 items.forEach(item=>{
  total+=item.priceMinor*item.quantity;count+=item.quantity;
  const row=el('div','marketplace-cart-item');
  row.append(el('span','',item.title+' × '+item.quantity),el('strong','',money(item.priceMinor*item.quantity,item.currency)));
  const remove=el('button','search-result-action','Remove');remove.type='button';remove.addEventListener('click',()=>{cart.delete(item.listingId);renderCart();});
  row.append(remove);box.append(row);
 });
 if(summary)summary.textContent=items.length?count+' item(s) · subtotal '+money(total):'No items selected.';
 if(id('marketplace-checkout'))id('marketplace-checkout').disabled=!items.length||busy;
 if(!items.length)box.append(el('p','marketplace-empty','Add items from active listings to prepare an order.'));
}
async function loadMine(){
 const box=id('marketplace-my-listings');if(!box)return;
 if(!getSession()){box.replaceChildren(el('p','marketplace-empty','Sign in to manage your listings.'));return;}
 box.replaceChildren(el('p','marketplace-empty','Loading your seller listings…'));
 try{
  const result=await requestJson('/api/marketplace/listings/mine');box.replaceChildren();
  if(!result.listings?.length){box.append(el('p','marketplace-empty','No listings yet. Create a draft above.'));return;}
  result.listings.forEach(item=>{
   const row=el('article','marketplace-my-listing');row.append(el('strong','',item.title),el('span','',item.status+' · '+money(item.priceMinor,item.currency)));
   row.append(el('small','',Number(item.quantityAvailable??0)+' total · '+Number(item.quantityReserved??0)+' reserved'));
   if(['draft','paused','active'].includes(item.status)){
    const next=item.status==='active'?'paused':'active';
    const button=el('button','button button-secondary button-small',next==='active'?'Publish listing':'Pause listing');button.type='button';
    button.addEventListener('click',async()=>{button.disabled=true;try{await requestJson('/api/marketplace/listings/'+encodeURIComponent(item.id)+'/status',{method:'PATCH',body:{status:next}});await loadMine();await loadListings();}catch(error){status(error.message||'Listing state update failed.',true);}finally{button.disabled=false;}});
    row.append(button);
   }
   box.append(row);
  });
 }catch(error){box.replaceChildren(el('p','marketplace-empty',error.message||'Seller listings unavailable.'));}
}
async function loadOrders(){
 const box=id('marketplace-orders-list');if(!box)return;
 if(!getSession()){box.replaceChildren(el('p','marketplace-empty','Sign in to view your orders.'));return;}
 box.replaceChildren(el('p','marketplace-empty','Loading orders…'));
 try{
  const result=await requestJson('/api/marketplace/orders');box.replaceChildren();
  if(!result.orders?.length){box.append(el('p','marketplace-empty','No marketplace orders yet.'));return;}
  result.orders.forEach(order=>{
   const row=el('article','marketplace-order-card');row.append(el('strong','',money(order.totalMinor,order.currency)+' · '+order.status),el('small','',new Date(order.createdAt).toLocaleString()));
   (order.items||[]).forEach(item=>row.append(el('p','',item.quantity+' × '+item.listingId+' · '+money(item.lineTotalMinor,order.currency))));
   box.append(row);
  });
 }catch(error){box.replaceChildren(el('p','marketplace-empty',error.message||'Orders unavailable.'));}
}
async function checkout(){
 if(!requireAuth()||busy||!cart.size)return;
 busy=true;renderCart();status('Reserving available stock and creating a PayPal order…');
 const button=id('marketplace-checkout');if(button)button.disabled=true;
 try{
  const result=await requestJson('/api/marketplace/orders',{method:'POST',headers:{'Idempotency-Key':makeKey()},body:{items:[...cart.values()].map(item=>({listingId:item.listingId,quantity:item.quantity}))}});
  if(!result.order?.approvalUrl)throw new Error('The server did not return an approval URL. No payment was marked complete.');
  const target=new URL(result.order.approvalUrl);
  if(target.protocol!=='https:'||!(target.hostname==='paypal.com'||target.hostname.endsWith('.paypal.com')))throw new Error('The provider approval URL was not trusted; checkout was not opened.');
  status('Order '+result.order.id+' created. PayPal approval is required; stock is reserved and no sale is yet recorded.');
  window.location.assign(target.toString());
 }catch(error){status(error.message||'Checkout failed. Check order status before retrying.',true);busy=false;renderCart();}
}
function cleanReturn(){const url=new URL(window.location.href);url.searchParams.delete('commerce');url.searchParams.delete('order');window.history.replaceState({},'',url.pathname+url.search+url.hash);}
async function handleReturn(){
 const url=new URL(window.location.href);const mode=url.searchParams.get('commerce');const orderId=url.searchParams.get('order');
 if(!mode)return;
 if(!getSession()){status('Sign in to verify the marketplace order returned by PayPal. No order is marked paid in the browser.');return;}
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId||'')){status('The return URL did not contain a valid ZUNO order ID.',true);cleanReturn();return;}
 if(mode==='cancel'){
  try{await requestJson('/api/marketplace/orders/'+encodeURIComponent(orderId)+'/cancel',{method:'POST',body:{}});status('Checkout was cancelled. Reserved stock was released.');cleanReturn();await Promise.all([loadListings(),loadMine(),loadOrders()]);}
  catch(error){status(error.message||'Cancellation needs reconciliation.',true);}
  return;
 }
 if(mode!=='return')return;
 status('Verifying PayPal capture and updating inventory…');
 try{
  const result=await requestJson('/api/marketplace/orders/'+encodeURIComponent(orderId)+'/capture',{method:'POST',body:{}});
  if(result.order?.status==='paid'){cart.clear();renderCart();status('Payment verified. Order '+orderId+' is paid.');cleanReturn();await Promise.all([loadListings(),loadMine(),loadOrders()]);}
  else status('The provider has not confirmed capture. Order remains pending; do not submit another order.',true);
 }catch(error){status(error.status===401?'Sign in to reconcile this order.':(error.message||'Payment reconciliation pending. Do not buy again.'),true);}
}
export function mountMarketplace(){
 id('marketplace-refresh')?.addEventListener('click',loadListings);
 id('marketplace-search')?.addEventListener('click',loadListings);
 id('marketplace-query')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();loadListings();}});
 id('marketplace-clear-cart')?.addEventListener('click',()=>{cart.clear();renderCart();});
 id('marketplace-checkout')?.addEventListener('click',checkout);
 id('marketplace-orders-refresh')?.addEventListener('click',loadOrders);
 id('marketplace-my-listings-refresh')?.addEventListener('click',loadMine);
 id('marketplace-listing-form')?.addEventListener('submit',async event=>{
  event.preventDefault();if(!requireAuth())return;
  const price=Number(id('marketplace-listing-price')?.value);
  const quantity=Number(id('marketplace-listing-quantity')?.value);
  if(!Number.isFinite(price)||Math.round(price*100)!==price*100||price<=0||!Number.isSafeInteger(quantity)||quantity<0){status('Enter a positive price with at most two decimals and an integer stock quantity.',true);return;}
  const submit=id('marketplace-listing-submit');submit.disabled=true;status('Creating a draft listing and inventory record…');
  try{
   const result=await requestJson('/api/marketplace/listings',{method:'POST',headers:{'Idempotency-Key':makeKey()},body:{
    title:id('marketplace-listing-title').value.trim(),description:id('marketplace-listing-description').value.trim(),
    category:id('marketplace-listing-category').value.trim(),priceMinor:Math.round(price*100),quantity
   }});
   event.currentTarget.reset();status('Draft listing created. Publish it from Your listings when ready.');await loadMine();
  }catch(error){status(error.message||'Listing creation failed.',true);}
  finally{submit.disabled=false;}
 });
 window.addEventListener('zuno:session-change',()=>{loadListings();loadMine();loadOrders();});
 loadListings();loadMine();loadOrders();renderCart();handleReturn();
}
