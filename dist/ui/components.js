import { difficultyFor } from '../difficulty.js';

const iconPaths = {
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  audio: 'M11 4 6 8H2v8h4l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  chevron: 'm9 5 7 7-7 7',
  back: 'm14 5-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z',
  lock: 'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',
  copy: 'M8 8h12v13H8zM4 16H3V3h12v2',
  check: 'm5 12 4 4 10-10',
  swords: 'm4 3 17 17M3 4l4-1-1 4M20 3 3 20m18-16-4-1 1 4M2 16l6 6m8-20 6 6',
  transfer: 'M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4',
  skip: 'm5 5 10 7-10 7zM19 5v14',
  fast: 'm2 5 9 7-9 7zm10 0 9 7-9 7z',
  pause: 'M8 5v14M16 5v14',
  play: 'm7 4 13 8-13 8z',
  history: 'M3 4v6h6M4 9a9 9 0 1 1 0 7m8-10v6l4 2',
  users:
    'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3m13-16a4 4 0 0 1 0 8m6 8v-3a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  info: 'M12 11v6M12 7v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  close: 'm6 6 12 12M6 18 18 6',
  refresh: 'M20 4v6h-6M4 20v-6h6M4 9a8 8 0 0 1 13-5m3 11a8 8 0 0 1-13 5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  trophy: 'M8 3h8v8a4 4 0 0 1-8 0zM8 5H3v3a5 5 0 0 0 5 5m8-8h5v3a5 5 0 0 1-5 5M12 15v6m-5 0h10',
  save: 'M5 3h12l4 4v14H3V3zm3 0v7h8V3M7 21v-7h10v7',
  logout: 'M10 3H4v18h6m4-5 5-4-5-4m-5 4h10',
  mail: 'M3 5h18v14H3zm0 1 9 7 9-7',
};

export const renderIcon = (name) =>
  /* HTML */ `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="${iconPaths[name] || iconPaths.globe}" />
  </svg>`;

export const renderButton = (text, action, variant = '', extra = '') =>
  /* HTML */ `<button type="button" class="btn ${variant}" data-action="${action}" ${extra}
    >${text}</button
  >`;

export const renderDifficultyBadge = (id) => {
  const level = difficultyFor(id);
  return /* HTML */ `<span
    class="badge difficulty-badge"
    style="--difficulty-colour:${level.colour}"
    >${level.label}</span
  >`;
};

export const renderBrand = () =>
  /* HTML */ `<a href="#welcome" class="brand" aria-label="Meridian Conquest home"
    ><img src="./assets/compass.svg" alt="" /><span class="brand-title"
      >MERIDIAN<span>CONQUEST</span></span
    ></a
  >`;
