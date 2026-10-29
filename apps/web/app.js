import { mountNavigation } from './src/components/navigation.js';
import { mountSearch } from './src/features/search/search.js';
import { mountComposer } from './src/features/creation/composer.js';
import { mountGiftCatalog } from './src/features/gifts/catalog.js';
import { mountLiveRooms } from './src/features/livestreaming/live-room.js';
import { mountActions } from './src/features/actions.js';
import { mountAuth } from './src/features/auth/auth-ui.js';
import { mountFeed } from './src/features/feed/feed.js';
import { mountWallet } from './src/features/auth/wallet.js';
import { mountCommunities } from './src/features/communities/communities.js';
import { mountMarketplace } from './src/features/marketplace/marketplace.js';
import { mountSubscriptions } from './src/features/subscriptions/subscriptions.js';

mountNavigation();
mountSearch();
mountComposer();
mountActions();
mountAuth();
mountFeed();
mountWallet();
mountCommunities();
mountMarketplace();
mountSubscriptions();
mountGiftCatalog();
mountLiveRooms();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    const source = document.getElementById('gift-source');
    if (source) source.textContent += ' · Offline cache unavailable';
  });
}
