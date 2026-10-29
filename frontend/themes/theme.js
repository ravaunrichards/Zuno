'use strict';
const themes = {
  dark: { background: '#0d0d15', surface: '#171725', text: '#f7f6ff', muted: '#a5a3bd', accent: '#9a7cff' },
  light: { background: '#f6f5fb', surface: '#ffffff', text: '#19172a', muted: '#625f79', accent: '#6d50dc' }
};
function getTheme(name) { return themes[name] || themes.dark; }
module.exports = { themes, getTheme };
