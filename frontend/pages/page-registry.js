'use strict';
module.exports = {
  home: { title: 'Home', sectionId: 'home', requiresAuth: false },
  discover: { title: 'Discover', sectionId: 'discover', requiresAuth: false },
  live: { title: 'LIVE', sectionId: 'live', requiresAuth: false },
  messages: { title: 'Messages', sectionId: 'messages', requiresAuth: true },
  communities: { title: 'Communities', sectionId: 'communities', requiresAuth: false },
  creator: { title: 'Creator Studio', sectionId: 'creator', requiresAuth: true },
  notifications: { title: 'Notifications', sectionId: 'notifications', requiresAuth: true },
  wallet: { title: 'Z Coins & wallet', sectionId: 'wallet', requiresAuth: true },
  profile: { title: 'Profile', sectionId: 'profile', requiresAuth: true }
};
