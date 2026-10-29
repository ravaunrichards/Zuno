import { mountNavigation } from './src/components/navigation.js';
import { mountSearch } from './src/features/search/search.js';
import { mountComposer } from './src/features/creation/composer.js';
import { mountGiftCatalog } from './src/features/gifts/catalog.js';
import { mountLivePreview } from './src/features/livestreaming/live-preview.js';
import { mountActions } from './src/features/actions.js';
mountNavigation();
mountSearch();
mountComposer();
mountActions();
mountGiftCatalog();
mountLivePreview();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    const source = document.getElementById('gift-source');
    if (source) source.textContent += ' · Offline cache unavailable';
  });
}
