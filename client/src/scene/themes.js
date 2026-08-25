// Board environments — each swaps the sky, fog, floor, lighting, and tile/
// frame/inlay colors that scene/setupScene.js and scene/board.js otherwise
// hardcode. Picked once on the menu (like a time control) rather than
// live-swapped mid-game, since rebuilding the sky/lighting/board materials
// in place isn't worth the complexity for something chosen before a game
// starts.
export const THEMES = [
  {
    id: 'throne-room',
    name: 'Throne Room',
    sky: {
      type: 'night',
      stops: [
        [0, '#03040a'],
        [0.4, '#080a16'],
        [0.68, '#121628'],
        [0.85, '#232538'],
        [1, '#0a0912'],
      ],
    },
    fog: { color: 0x0e0f1a, density: 0.045 },
    floorColor: '#1c1712',
    lights: {
      ambient: { color: 0x9a8a6a, intensity: 0.32 },
      key: { color: 0xfff2d8, intensity: 0.95 },
      rim: { color: 0x8fa8c4, intensity: 0.22 },
      glowA: { color: 0xe08838, intensity: 0.7 },
      glowB: { color: 0xe08838, intensity: 0.7 },
    },
    board: {
      light: { base: '#e6dabd', vein: '#b89a5e' },
      dark: { base: '#332c22', vein: '#5a4a30' },
      frameColor: '#2a251e',
      inlayColor: 0xc4953a,
    },
  },
  {
    id: 'siege-camp',
    name: 'Siege Camp',
    sky: {
      type: 'gradient',
      stops: [
        [0, '#2a160e'],
        [0.45, '#6a3620'],
        [0.8, '#a85a2e'],
        [1, '#c9803e'],
      ],
    },
    fog: { color: 0x3a2418, density: 0.05 },
    floorColor: '#4a3a26',
    lights: {
      ambient: { color: 0xcc9966, intensity: 0.32 },
      key: { color: 0xffb066, intensity: 1.0 },
      rim: { color: 0xff6a33, intensity: 0.28 },
      glowA: { color: 0xff7722, intensity: 0.85 },
      glowB: { color: 0xff7722, intensity: 0.85 },
    },
    board: {
      light: { base: '#c9a876', vein: '#8a6a44' },
      dark: { base: '#4a3826', vein: '#2a1e14' },
      frameColor: '#3a2e1e',
      inlayColor: 0x8a6030,
    },
  },
  {
    id: 'forest-glade',
    name: 'Forest Glade',
    sky: {
      type: 'gradient',
      stops: [
        [0, '#16301f'],
        [0.5, '#3f6b46'],
        [0.8, '#7fa46a'],
        [1, '#c4d9a0'],
      ],
    },
    fog: { color: 0x3a5a44, density: 0.04 },
    floorColor: '#2e4a30',
    lights: {
      ambient: { color: 0x8fbf8a, intensity: 0.4 },
      key: { color: 0xd8f0c0, intensity: 0.85 },
      rim: { color: 0x6a9a6a, intensity: 0.25 },
      glowA: { color: 0x9fd88a, intensity: 0.5 },
      glowB: { color: 0x9fd88a, intensity: 0.5 },
    },
    board: {
      light: { base: '#d8c896', vein: '#a89860' },
      dark: { base: '#3a4a2e', vein: '#5a6a3e' },
      frameColor: '#2a3a1e',
      inlayColor: 0x7a9450,
    },
  },
];

const THEME_KEY = 'gambit_theme';
const DEFAULT_THEME_ID = THEMES[0].id;

export function getTheme() {
  const id = localStorage.getItem(THEME_KEY) || DEFAULT_THEME_ID;
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function setTheme(id) {
  localStorage.setItem(THEME_KEY, id);
}
