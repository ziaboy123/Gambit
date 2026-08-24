import * as THREE from 'three';

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Polished marble tile: base fill + soft curved veins + fine speckle grain.
export function generateMarbleTexture(baseHex, veinHex, seed = 1, size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(seed);

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);

  // Soft blotchy shading for depth
  for (let i = 0; i < 14; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.15 + rand() * 0.25);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const shade = rand() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    grad.addColorStop(0, shade);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }

  // Veins
  ctx.strokeStyle = veinHex;
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    ctx.globalAlpha = 0.12 + rand() * 0.12;
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    let x = rand() * size;
    let y = rand() * size;
    ctx.moveTo(x, y);
    const segments = 4 + Math.floor(rand() * 3);
    for (let s = 0; s < segments; s++) {
      x += (rand() - 0.5) * size * 0.5;
      y += (rand() - 0.5) * size * 0.5;
      const cx = x + (rand() - 0.5) * size * 0.3;
      const cy = y + (rand() - 0.5) * size * 0.3;
      ctx.quadraticCurveTo(cx, cy, x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Fine grain speckle
  const imgData = ctx.getImageData(0, 0, size, size);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 10;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Rougher speckled stone for the frame/floor — no veining, denser grain.
export function generateStoneTexture(baseHex, seed = 7, size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(seed);

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 900; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.5 + rand() * 2.2;
    ctx.fillStyle = rand() > 0.5
      ? `rgba(255,255,255,${0.03 + rand() * 0.05})`
      : `rgba(0,0,0,${0.03 + rand() * 0.06})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 10; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.08 + rand() * 0.18);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(0,0,0,0.06)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Vertical gradient backdrop for a torch-lit great hall.
export function generateSkyGradient(stops, width = 4, height = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  stops.forEach(([offset, color]) => grad.addColorStop(offset, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Misty night sky: vertical gradient + scattered stars, fading out near the
// horizon (stars stop partway down so they don't read as floating over the
// ground haze).
export function generateNightSky(stops, seed = 3, size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(seed);

  const grad = ctx.createLinearGradient(0, 0, 0, size);
  stops.forEach(([offset, color]) => grad.addColorStop(offset, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Stars — denser near the top (zenith), thinning toward the horizon haze.
  const starCount = 700;
  for (let i = 0; i < starCount; i++) {
    const x = rand() * size;
    const yBias = Math.pow(rand(), 1.6); // bias toward top
    const y = yBias * size * 0.75;
    const r = rand() * rand() * 1.6 + 0.2;
    const brightness = 0.3 + rand() * 0.7;
    ctx.fillStyle = `rgba(230,235,255,${brightness})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (r > 1.1) {
      // subtle twinkle glow on the brighter stars
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      glow.addColorStop(0, `rgba(200,215,255,${brightness * 0.25})`);
      glow.addColorStop(1, 'rgba(200,215,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Low horizon mist band
  const mist = ctx.createLinearGradient(0, size * 0.62, 0, size * 0.95);
  mist.addColorStop(0, 'rgba(70,80,110,0)');
  mist.addColorStop(1, 'rgba(70,80,110,0.35)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, size * 0.55, size, size * 0.45);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
