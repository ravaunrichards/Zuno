function toast(message) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
export function mountActions() {
  document.querySelectorAll('[data-action="wallet-info"]').forEach((button) => button.addEventListener('click', () => toast('Wallet balance and recharge checkout require a verified signed-in account and provider-backed ledger.')));
  document.querySelectorAll('[data-action="profile-info"]').forEach((button) => button.addEventListener('click', () => toast('Profile editing becomes available after authentication and profile APIs are connected.')));
  document.querySelectorAll('[data-action="open-studio"]').forEach((button) => button.addEventListener('click', () => { window.location.href = '../creator-studio/index.html'; }));
}
