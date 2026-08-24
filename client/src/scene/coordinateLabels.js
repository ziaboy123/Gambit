import * as THREE from 'three';
import { FILES, SQUARE_SIZE } from './board.js';

function makeLabelTexture(text) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#c4953a';
  ctx.font = '700 76px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLabelMesh(text) {
  const geo = new THREE.PlaneGeometry(0.3, 0.3);
  const mat = new THREE.MeshBasicMaterial({
    map: makeLabelTexture(text),
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

export function buildCoordinateLabels(scene) {
  const group = new THREE.Group();
  group.name = 'coordinate-labels';
  const edge = 4.18;
  const y = 0.015;

  FILES.forEach((letter, i) => {
    const x = (i - 3.5) * SQUARE_SIZE;
    const front = makeLabelMesh(letter);
    front.position.set(x, y, edge);
    group.add(front);

    const back = makeLabelMesh(letter);
    back.position.set(x, y, -edge);
    group.add(back);
  });

  for (let rank = 1; rank <= 8; rank++) {
    const z = (3.5 - (rank - 1)) * SQUARE_SIZE;
    const left = makeLabelMesh(String(rank));
    left.position.set(-edge, y, z);
    group.add(left);

    const right = makeLabelMesh(String(rank));
    right.position.set(edge, y, z);
    group.add(right);
  }

  scene.add(group);
  return group;
}
