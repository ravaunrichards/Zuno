'use strict';
// Intentionally expose no Node APIs to the web renderer. Privileged capabilities
// must be added as narrow, reviewed message handlers if a desktop feature needs them.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.zunoDesktop = 'true';
});
