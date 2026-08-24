export const TIME_CONTROLS = {
  bullet: { label: 'Bullet · 2+1', baseMs: 2 * 60 * 1000, incrementMs: 1000 },
  blitz: { label: 'Blitz · 5+0', baseMs: 5 * 60 * 1000, incrementMs: 0 },
  rapid: { label: 'Rapid · 10+0', baseMs: 10 * 60 * 1000, incrementMs: 0 },
  classical: { label: 'Classical · 30+0', baseMs: 30 * 60 * 1000, incrementMs: 0 },
  untimed: { label: 'Untimed', baseMs: null, incrementMs: 0 },
};

export function resolveTimeControl(key) {
  return TIME_CONTROLS[key] || TIME_CONTROLS.untimed;
}
