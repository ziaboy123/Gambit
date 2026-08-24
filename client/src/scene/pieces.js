import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { getModel } from './assetLoader.js';

// Target standing height (world units) per piece type — establishes the
// classic chess hierarchy silhouette (king/queen tallest, pawns shortest).
const TARGET_HEIGHT = { p: 0.62, n: 0.78, b: 0.8, r: 0.72, q: 0.92, k: 1.0 };

// Lerp factors (not multiply — multiply can only darken, never brighten a
// naturally dark source texture, which broke the white faction entirely).
const FACTION_TINT = {
  w: { color: new THREE.Color(0xf0ead6), amount: 0.72 },
  b: { color: new THREE.Color(0x18140f), amount: 0.62 },
};

// The two armies face each other across the board — white's own pieces show
// their backs to the white/human player (facing the enemy), and black's
// pieces show their fronts (also facing the enemy, i.e. toward the camera).
// The source rigs' walk/attack clips carry root-motion rotation that fights
// a one-time rotation.y assignment, so this value gets re-asserted on the
// locked root every frame (see pieceManager.tick) instead of just set once.
const FACE_ROTATION_Y = { w: Math.PI, b: 0 };

const GOLD_TRIM = () => new THREE.MeshPhysicalMaterial({
  color: 0xc4953a, roughness: 0.22, metalness: 0.9,
  clearcoat: 0.4, clearcoatRoughness: 0.15,
});

function findIdleClip(animations) {
  return (
    animations.find((c) => /idle/i.test(c.name)) ||
    animations.find((c) => /breath|stand/i.test(c.name)) ||
    animations[0] ||
    null
  );
}

// Preferred attack clip per piece type, in priority order — falls back
// through the list since not every character's clip set is identical.
const ATTACK_CLIP_CANDIDATES = {
  p: ['Dagger_Attack', 'Dagger_Attack2', 'Punch'],
  n: ['Sword_Attack', 'Sword_Attack2', 'Punch'],
  b: ['Attack', 'Attack2', 'Punch'],
  q: ['Staff_Attack', 'Spell1', 'Punch'],
  k: ['Spell1', 'Staff_Attack', 'Punch'],
};

function resolveClips(type, animations) {
  const byName = (name) => animations.find((c) => c.name === name) || null;
  const candidates = ATTACK_CLIP_CANDIDATES[type] || ['Punch'];
  let attack = null;
  for (const name of candidates) {
    attack = byName(name);
    if (attack) break;
  }
  return {
    idle: findIdleClip(animations),
    attack,
    death: byName('Death'),
    run: byName('Walk') || byName('Run'),
  };
}

function tintMesh(root, tint) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    // SkeletonUtils.clone() shares material references with the cached
    // source scene — clone here so tinting one instance never mutates
    // another piece (or the shared source) sharing the same material.
    const cloneOne = (mat) => {
      if (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial) return mat;
      const cloned = mat.clone();
      cloned.color = (mat.color ? mat.color.clone() : new THREE.Color(0xffffff))
        .lerp(tint.color, tint.amount);
      return cloned;
    };
    obj.material = Array.isArray(obj.material)
      ? obj.material.map(cloneOne)
      : cloneOne(obj.material);
  });
}

function buildCharacterPiece(type, color) {
  const source = getModel(type);
  if (!source) return null;

  const clone = cloneSkeleton(source.scene);
  tintMesh(clone, FACTION_TINT[color]);

  // Normalize scale/position: measure the bind-pose bounding box, scale to
  // the target height, and sit the feet on y=0, centered on x/z.
  const box = new THREE.Box3().setFromObject(clone);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = TARGET_HEIGHT[type] / (size.y || 1);
  clone.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(clone);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  clone.position.x -= center.x;
  clone.position.z -= center.z;
  clone.position.y -= box2.min.y;
  clone.rotation.y = FACE_ROTATION_Y[color];

  const group = new THREE.Group();
  group.add(clone);

  let mixer = null;
  let clips = null;
  if (source.animations?.length) {
    mixer = new THREE.AnimationMixer(clone);
    clips = resolveClips(type, source.animations);
    if (clips.idle) mixer.clipAction(clips.idle).play();
  }
  group.userData.mixer = mixer;
  group.userData.clips = clips;

  // Re-asserted every frame by PieceManager to override any root-motion
  // rotation/position baked into the animation clips.
  group.userData.facingLock = {
    root: clone,
    rotationY: FACE_ROTATION_Y[color],
    position: clone.position.clone(),
  };

  if (type === 'q' || type === 'k') {
    const crown = buildCrown();
    crown.position.y = box2.max.y + 0.02;
    group.add(crown);
  }

  return group;
}

function buildCrown() {
  const g = new THREE.Group();
  const trim = GOLD_TRIM();
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 8, 20), trim);
  band.rotation.x = Math.PI / 2;
  g.add(band);
  const spikes = 6;
  for (let i = 0; i < spikes; i++) {
    const angle = (i / spikes) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.05, 6), trim);
    spike.position.set(Math.cos(angle) * 0.075, 0.03, Math.sin(angle) * 0.075);
    g.add(spike);
  }
  return g;
}

function buildRookTower(color) {
  const group = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({
    color: color === 'w' ? 0xd8cdb0 : 0x2a2620,
    roughness: 0.85,
    metalness: 0.05,
  });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.16, 16), stoneMat);
  base.position.y = 0.08;
  group.add(base);

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.42, 16), stoneMat);
  shaft.position.y = 0.16 + 0.21;
  group.add(shaft);

  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.22, 0.06, 16), stoneMat);
  rim.position.y = 0.16 + 0.42 + 0.03;
  group.add(rim);

  const crenelCount = 8;
  const crenelTopY = 0.16 + 0.42 + 0.06 + 0.055;
  for (let i = 0; i < crenelCount; i++) {
    const angle = (i / crenelCount) * Math.PI * 2;
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.06), stoneMat);
    box.position.set(Math.cos(angle) * 0.21, crenelTopY, Math.sin(angle) * 0.21);
    box.lookAt(0, crenelTopY, 0);
    group.add(box);
  }

  group.traverse((obj) => {
    if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
  });

  return group;
}

export function createPieceMesh(type, color) {
  let piece = type === 'r' ? buildRookTower(color) : buildCharacterPiece(type, color);
  if (!piece) {
    // Fallback (models not loaded yet) — small placeholder marker.
    piece = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.24, 0.5, 12),
      new THREE.MeshStandardMaterial({ color: color === 'w' ? 0xe8ddc4 : 0x1c1916 })
    );
    piece.position.y = 0.25;
  }
  piece.userData.pieceType = type;
  piece.userData.pieceColor = color;
  return piece;
}
