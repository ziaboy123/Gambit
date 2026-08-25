import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// piece type -> source character model file (see README for CC0 attribution)
const MODEL_FILES = {
  p: 'Rogue.gltf',   // pawn — light common fighter
  n: 'Warrior.gltf', // knight — armored swordsman
  b: 'Monk.gltf',    // bishop — clergy
  q: 'Cleric.gltf',  // queen — robed, crowned
  k: 'Wizard.gltf',  // king — robed, crowned
  // 'r' (rook) has no character model — built procedurally as a tower.
};

const loader = new GLTFLoader();
const cache = {};

export async function loadPieceModels() {
  const entries = Object.entries(MODEL_FILES);
  await Promise.all(entries.map(async ([type, file]) => {
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`);
    normalizeMaterials(gltf.scene);
    cache[type] = gltf;
  }));
  return cache;
}

export function getModel(type) {
  return cache[type] || null;
}

// KHR_materials_unlit models load as MeshBasicMaterial, which ignores scene
// lighting — swap to MeshStandardMaterial so every piece responds to the
// same torch-lit environment consistently.
function normalizeMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const converted = mats.map((mat) => {
      if (mat.isMeshBasicMaterial) {
        return new THREE.MeshStandardMaterial({
          map: mat.map || null,
          color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          roughness: 0.6,
          metalness: 0.05,
        });
      }
      mat.roughness = mat.roughness ?? 0.6;
      return mat;
    });
    obj.material = Array.isArray(obj.material) ? converted : converted[0];
  });
}
