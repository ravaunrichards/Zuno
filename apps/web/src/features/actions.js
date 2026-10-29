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
  document.querySelectorAll('[data-action="open-studio"]').forEach((button) => button.addEventListener('click', () => { window.location.href = '../creator-studio/index.html'; }));
}
