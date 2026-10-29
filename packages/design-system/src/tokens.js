'use strict';
/** ZUNO design tokens — original branding (not derived from any other platform). */
module.exports = {
  color: {
    brand: '#5b2be0', brandAlt: '#00d4c8', ink: '#0d0d12', surface: '#15151d',
    surfaceAlt: '#1f1f2b', text: '#f4f4f8', textMuted: '#a0a0b4',
    success: '#2ecc71', warning: '#f1c40f', danger: '#e74c3c',
    live: '#ff2d55', coin: '#ffce3a',
  },
  radius: { sm: '6px', md: '12px', lg: '20px', pill: '999px' },
  space: [0, 4, 8, 12, 16, 24, 32, 48, 64],
  font: { sans: "'Inter', system-ui, sans-serif", display: "'Sora', 'Inter', sans-serif" },
  motion: { fast: '120ms', base: '220ms', slow: '420ms' },
  theme: { light: { bg: '#ffffff', text: '#0d0d12' }, dark: { bg: '#0d0d12', text: '#f4f4f8' } },
};
