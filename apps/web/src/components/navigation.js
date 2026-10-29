export function mountNavigation() {
  const links = Array.from(document.querySelectorAll('[data-nav]'));
  const title = document.getElementById('page-title');
  const labels = { home:'Home', discover:'Discover', feed:'For You Feed', live:'LIVE', messages:'Messages', communities:'Communities', creator:'Creator Studio', notifications:'Notifications', wallet:'Z Coins & wallet', profile:'Profile' };
  function activate(id) {
    links.forEach((link) => link.classList.toggle('is-active', link.dataset.nav === id));
    if (title && labels[id]) title.textContent = labels[id];
  }
  links.forEach((link) => link.addEventListener('click', () => activate(link.dataset.nav)));
  document.querySelectorAll('[data-nav-target]').forEach((button) => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.navTarget);
    if (target) { target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); activate(button.dataset.navTarget); }
  }));
  document.querySelectorAll('[data-action="menu"]').forEach((button) => button.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const visible = sidebar.classList.toggle('sidebar-mobile-open');
    button.setAttribute('aria-expanded', String(visible));
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault();
      const search = document.getElementById('search-input');
      if (search) search.focus();
    }
  });
  const sections = Array.from(document.querySelectorAll('main [id]')).filter((el) => labels[el.id]);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const best = entries.filter((entry) => entry.isIntersecting).sort((a,b) => b.intersectionRatio-a.intersectionRatio)[0];
      if (best) activate(best.target.id);
    }, { rootMargin: '-18% 0px -70% 0px', threshold: [0, .25, .5] });
    sections.forEach((section) => observer.observe(section));
  }
  return { activate };
}
