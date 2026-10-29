import { requestJson } from '../../services/api-client.js';
import { getSession } from './session.js';

let packages = [];
let checkoutEnabled = false;
let payoutsEnabled = false;
let busy = false;
let returnCaptureInProgress = false;
let returnHandled = false;

function $id(id) { return document.getElementById(id); }
function say(message, error = false) {
  const status = $id('wallet-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', Boolean(error));
}
function money(value) {
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value));
}
const PENDING_CHECKOUT_KEY = 'zuno:pending-checkout';
function safeIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  }
  throw new Error('Secure payment request IDs are not supported by this browser. Use an updated browser over HTTPS.');
}
function quoteFingerprint(body) {
  return body.packageId ? 'package:' + body.packageId : 'custom:' + Number(body.customAmountUSD).toFixed(2);
}
function obtainCheckoutKey(body) {
  const fingerprint = quoteFingerprint(body);
  try {
    const existing = JSON.parse(localStorage.getItem(PENDING_CHECKOUT_KEY) || 'null');
    if (existing && existing.fingerprint === fingerprint && typeof existing.key === 'string' && existing.key.length >= 16) return existing.key;
  } catch (_) {}
  const key = safeIdempotencyKey();
  try { localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({ key, fingerprint, createdAt: Date.now() })); } catch (_) {}
  return key;
}
function clearCheckoutKey(expectedOrderId) {
  try {
    const existing = JSON.parse(localStorage.getItem(PENDING_CHECKOUT_KEY) || 'null');
    if (!expectedOrderId || !existing || !existing.orderId || existing.orderId === expectedOrderId) localStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch (_) {}
}
function rememberCheckoutOrder(orderId) {
  try {
    const existing = JSON.parse(localStorage.getItem(PENDING_CHECKOUT_KEY) || 'null');
    if (existing && typeof existing.key === 'string') {
      existing.orderId = orderId;
      localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(existing));
    }
  } catch (_) {}
}
function setButtonsDisabled(disabled) {
  document.querySelectorAll('[data-recharge-package]').forEach(button => { button.disabled = disabled; });
  const custom = $id('custom-recharge-submit');
  if (custom) custom.disabled = disabled;
}
function renderPackages() {
  const grid = $id('wallet-packages');
  if (!grid) return;
  grid.replaceChildren();
  if (!packages.length) {
    const p = document.createElement('p');
    p.className = 'wallet-inline-status';
    p.textContent = 'No enabled recharge packages were returned by the database.';
    grid.append(p);
    return;
  }
  for (const item of packages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recharge-package';
    button.dataset.rechargePackage = item.id;
    const count = document.createElement('strong');
    count.textContent = new Intl.NumberFormat().format(item.coins) + ' Z Coins';
    const price = document.createElement('span');
    price.textContent = money(item.amountUSD);
    const detail = document.createElement('small');
    detail.textContent = 'Secure PayPal checkout';
    button.append(count,price,detail);
    button.disabled = !getSession() || !checkoutEnabled || busy;
    button.addEventListener('click', () => beginCheckout({packageId:item.id, button}));
    grid.append(button);
  }
}
async function refreshWallet() {
  const balance = $id('wallet-balance');
  const note = $id('wallet-ledger-note');
  if (!getSession()) {
    if (balance) balance.textContent = 'Sign in required';
    if (note) note.textContent = 'No client-side balance is stored as authoritative.';
    checkoutEnabled = false;
    renderPackages();
    say('Sign in to view your wallet or start checkout.');
    setButtonsDisabled(true);
    return;
  }
  try {
    const result = await requestJson('/api/wallet');
    if (balance) {
      balance.textContent = result.wallet && result.wallet.initialized && Number.isFinite(Number(result.wallet.coinBalance))
        ? new Intl.NumberFormat().format(Number(result.wallet.coinBalance)) + ' Z Coins'
        : 'Wallet not provisioned';
    }
    checkoutEnabled = Boolean(result.checkoutEnabled);
    payoutsEnabled = Boolean(result.payoutsEnabled);
    if (note) note.textContent = result.wallet && result.wallet.restricted
      ? 'Wallet restricted while a payment reversal is reconciled.'
      : result.wallet && result.wallet.initialized
        ? 'Calculated from the database ledger.'
        : (result.wallet && result.wallet.note || 'Wallet data is not available yet.');
    if (result.wallet && result.wallet.restricted) {
      checkoutEnabled = false;
      say('Your wallet is temporarily restricted pending provider reconciliation. New spending is disabled.', true);
    } else if (checkoutEnabled) {
      say('PayPal checkout is configured. Coins are added only after verified capture reconciliation.');
    } else {
      say('Recharge packages are visible, but checkout is disabled until PayPal credentials and required safeguards are configured.');
    }
    if (payoutsEnabled) {
      say('Wallet refreshed. Creator payout eligibility is enabled by server configuration.');
    }
  } catch (error) {
    checkoutEnabled = false;
    if (balance) balance.textContent = 'Unavailable';
    if (note) note.textContent = 'A live database balance could not be fetched.';
    say(error.status === 401 ? 'Sign in to view your wallet.' : (error.message || 'Wallet data is temporarily unavailable.'), true);
  }
  renderPackages();
  setButtonsDisabled(!checkoutEnabled || !getSession() || busy);
}
async function loadPackages() {
  const grid = $id('wallet-packages');
  try {
    const result = await requestJson('/api/payments/packages');
    packages = Array.isArray(result.packages) ? result.packages.filter(item =>
      typeof item.id === 'string' && Number.isSafeInteger(Number(item.coins)) &&
      Number(item.coins)>0 && Number.isFinite(Number(item.amountUSD)) && Number(item.amountUSD)>0
    ) : [];
    if (!packages.length && grid) {
      const p = document.createElement('p');
      p.className = 'wallet-inline-status';
      p.textContent = 'The API did not return any enabled recharge packages.';
      grid.replaceChildren(p);
    } else {
      renderPackages();
    }
  } catch (error) {
    if (grid) {
      grid.replaceChildren();
      const p = document.createElement('p');
      p.className = 'wallet-inline-status';
      p.textContent = error.message || 'Recharge packages could not be loaded from the API.';
      grid.append(p);
    }
  }
}
async function beginCheckout({packageId, customAmountUSD, button} = {}) {
  if (busy) return;
  if (!getSession()) {
    say('Sign in before creating a PayPal order.', true);
    $id('auth-state-button')?.click();
    return;
  }
  if (!checkoutEnabled) {
    say('Checkout is disabled by server configuration. No payment was created.', true);
    return;
  }
  let approvalUrl = null;
  busy = true;
  if (button) button.disabled = true;
  setButtonsDisabled(true);
  try {
    const body = packageId ? {packageId} : {customAmountUSD:Number(customAmountUSD)};
    const result = await requestJson('/api/payments/order', {
      method:'POST',
      headers:{'Idempotency-Key':obtainCheckoutKey(body)},
      body
    });
    if (result.ok && result.order && result.order.state === 'credited') {
      clearCheckoutKey(result.order.id);
      say('This idempotent checkout order is already reconciled. ' + new Intl.NumberFormat().format(Number(result.order.coins||0)) + ' Z Coins were previously credited.');
      await refreshWallet();
      return;
    }
    if (!result.ok || !result.order || typeof result.order.approvalUrl !== 'string') {
      throw new Error('The server did not return a usable PayPal approval URL. No checkout redirect was started.');
    }
    rememberCheckoutOrder(result.order.id);
    const target = new URL(result.order.approvalUrl);
    if (target.protocol !== 'https:' || !(target.hostname === 'paypal.com' || target.hostname.endsWith('.paypal.com'))) {
      throw new Error('The payment provider returned an untrusted approval URL. Checkout was not opened.');
    }
    approvalUrl = target.toString();
    say('PayPal order created. Opening the provider approval page; no coins have been credited yet.');
    window.location.assign(approvalUrl);
  } catch (error) {
    if (error.code === 'PAYMENT_ORDER_NOT_OPEN' || error.code === 'IDEMPOTENCY_KEY_REUSED') clearCheckoutKey();
    say(error.message || 'Checkout could not be started.', true);
  } finally {
    if (!approvalUrl) {
      busy = false;
      if (button) button.disabled = false;
      renderPackages();
      setButtonsDisabled(!checkoutEnabled || !getSession());
    }
  }
}
function cleanPaymentReturnParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('payment');
  url.searchParams.delete('order');
  window.history.replaceState({},'',url.pathname + url.search + url.hash);
}
async function handlePaymentReturn() {
  if (returnCaptureInProgress || returnHandled) return;
  const url = new URL(window.location.href);
  const paymentStatus = url.searchParams.get('payment');
  const orderId = url.searchParams.get('order');
  if (paymentStatus === 'cancel') {
    returnHandled = true;
    say('PayPal checkout was cancelled. No coins were credited.');
    clearCheckoutKey(orderId || undefined);
    cleanPaymentReturnParams();
    return;
  }
  if (paymentStatus !== 'return') return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId || '')) {
    returnHandled = true;
    say('Payment return did not include a valid ZUNO order reference. Check order history before retrying.',true);
    cleanPaymentReturnParams();
    return;
  }
  if (!getSession()) {
    say('PayPal returned to ZUNO. Sign in to securely capture and reconcile your order.');
    return;
  }
  returnCaptureInProgress = true;
  try {
    say('PayPal returned. Verifying and capturing the provider order…');
    const result = await requestJson('/api/payments/orders/' + orderId + '/capture',{method:'POST',body:{}});
    if (result.ok && result.order && result.order.state === 'credited') {
      returnHandled = true;
      say('Payment capture is verified and reconciled. ' + new Intl.NumberFormat().format(Number(result.order.coins||0)) + ' Z Coins were credited.');
      const status = $id('wallet-order-status');
      if (status) status.textContent = 'Order ' + orderId + ' · ledger entry ' + (result.order.ledgerEntryId || 'recorded');
      clearCheckoutKey(orderId);
      cleanPaymentReturnParams();
      await refreshWallet();
    } else {
      say('The provider did not confirm a completed capture. No coin credit was claimed.',true);
    }
  } catch (error) {
    say(error.status===401?'Sign in to reconcile your payment order.':(error.message||'Capture reconciliation is pending. Do not create a second payment.'),true);
  } finally {
    returnCaptureInProgress = false;
  }
}
export function mountWallet() {
  const customForm = $id('custom-recharge-form');
  const customInput = $id('custom-recharge-amount');
  if (customForm) customForm.addEventListener('submit',event=>{
    event.preventDefault();
    if (!customInput || !customInput.value) return;
    const amount = Number(customInput.value);
    if (!Number.isFinite(amount) || Math.round(amount*100)/100!==amount || amount<0.99 || amount>999.99) {
      say('Custom recharge must be between USD 0.99 and USD 999.99.',true);
      return;
    }
    beginCheckout({customAmountUSD:amount,button:$id('custom-recharge-submit')});
  });
  $id('wallet-refresh')?.addEventListener('click',async()=>{await refreshWallet();await loadPackages();});
  window.addEventListener('zuno:session-change',async()=>{
    await refreshWallet();
    await handlePaymentReturn();
  });
  refreshWallet();
  loadPackages();
  handlePaymentReturn();
}
