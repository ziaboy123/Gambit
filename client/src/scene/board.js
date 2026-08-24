import * as THREE from 'three';
import { generateMarbleTexture, generateStoneTexture } from './textures.js';

export const SQUARE_SIZE = 1;
export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// Board is centered at the origin. a1 is at (-3.5, -3.5), h8 at (3.5, 3.5).
export function squareToPosition(square) {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7
  const rank = parseInt(square[1], 10) - 1; // 0-7
  return new THREE.Vector3(
    (file - 3.5) * SQUARE_SIZE,
    0,
    (3.5 - rank) * SQUARE_SIZE
  );
}

export function positionToSquare(x, z) {
  const file = Math.round(x / SQUARE_SIZE + 3.5);
  const rank = Math.round(3.5 - z / SQUARE_SIZE) + 1;
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
  return FILES[file] + rank;
}

const VARIANT_COUNT = 3;

export function buildBoard(scene) {
  const boardGroup = new THREE.Group();
  boardGroup.name = 'board';

  const lightMats = Array.from({ length: VARIANT_COUNT }, (_, i) =>
    new THREE.MeshStandardMaterial({
      map: generateMarbleTexture('#e6dabd', '#b89a5e', 100 + i, 512),
      roughness: 0.42,
      metalness: 0.06,
    })
  );
  const darkMats = Array.from({ length: VARIANT_COUNT }, (_, i) =>
    new THREE.MeshStandardMaterial({
      map: generateMarbleTexture('#332c22', '#5a4a30', 200 + i, 512),
      roughness: 0.38,
      metalness: 0.06,
    })
  );

  const tileGeo = new THREE.BoxGeometry(SQUARE_SIZE, 0.2, SQUARE_SIZE);
  const tileMeshes = {};

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const isLight = (file + rank) % 2 === 0;
      const variant = (file * 3 + rank * 5) % VARIANT_COUNT;
      const mat = isLight ? lightMats[variant] : darkMats[variant];
      const mesh = new THREE.Mesh(tileGeo, mat);
      const square = FILES[file] + (rank + 1);
      const pos = squareToPosition(square);
      mesh.position.set(pos.x, -0.1, pos.z);
      mesh.receiveShadow = true;
      mesh.userData.square = square;
      mesh.userData.baseMaterial = mat;
      boardGroup.add(mesh);
      tileMeshes[square] = mesh;
    }
  }

  // Gold inlay ring between the tiles and the outer stone frame.
  const inlayMat = new THREE.MeshPhysicalMaterial({
    color: 0xc4953a, roughness: 0.3, metalness: 0.85,
    clearcoat: 0.3, clearcoatRoughness: 0.2,
  });
  const inlayShape = new THREE.Shape();
  const inlayOuter = 4.12;
  inlayShape.moveTo(-inlayOuter, -inlayOuter);
  inlayShape.lineTo(inlayOuter, -inlayOuter);
  inlayShape.lineTo(inlayOuter, inlayOuter);
  inlayShape.lineTo(-inlayOuter, inlayOuter);
  inlayShape.lineTo(-inlayOuter, -inlayOuter);
  const inlayHole = new THREE.Path();
  inlayHole.moveTo(-4, -4);
  inlayHole.lineTo(4, -4);
  inlayHole.lineTo(4, 4);
  inlayHole.lineTo(-4, 4);
  inlayHole.lineTo(-4, -4);
  inlayShape.holes.push(inlayHole);
  const inlayGeo = new THREE.ExtrudeGeometry(inlayShape, { depth: 0.03, bevelEnabled: false });
  inlayGeo.rotateX(Math.PI / 2);
  const inlayMesh = new THREE.Mesh(inlayGeo, inlayMat);
  inlayMesh.position.y = -0.095;
  inlayMesh.receiveShadow = true;
  boardGroup.add(inlayMesh);

  // Stone frame/border around the inlay
  const frameTex = generateStoneTexture('#2a251e', 42, 512);
  frameTex.repeat.set(2, 2);
  const frameMat = new THREE.MeshStandardMaterial({ map: frameTex, roughness: 0.92, metalness: 0.04 });
  const frameThickness = 0.5;
  const frameHeight = 0.35;
  const outer = inlayOuter + frameThickness;

  const frameShape = new THREE.Shape();
  frameShape.moveTo(-outer, -outer);
  frameShape.lineTo(outer, -outer);
  frameShape.lineTo(outer, outer);
  frameShape.lineTo(-outer, outer);
  frameShape.lineTo(-outer, -outer);

  const hole = new THREE.Path();
  hole.moveTo(-inlayOuter, -inlayOuter);
  hole.lineTo(inlayOuter, -inlayOuter);
  hole.lineTo(inlayOuter, inlayOuter);
  hole.lineTo(-inlayOuter, inlayOuter);
  hole.lineTo(-inlayOuter, -inlayOuter);
  frameShape.holes.push(hole);

  const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: frameHeight, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
  frameGeo.rotateX(Math.PI / 2);
  const frameMesh = new THREE.Mesh(frameGeo, frameMat);
  frameMesh.position.y = -0.1 - frameHeight;
  frameMesh.receiveShadow = true;
  frameMesh.castShadow = true;
  boardGroup.add(frameMesh);

  // Corner ornaments — small gold pyramids marking each corner of the frame.
  const cornerMat = inlayMat;
  const cornerGeo = new THREE.ConeGeometry(0.14, 0.22, 4);
  const cornerOffset = outer - 0.22;
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
    const corner = new THREE.Mesh(cornerGeo, cornerMat);
    corner.position.set(sx * cornerOffset, 0.01, sz * cornerOffset);
    corner.rotation.y = Math.PI / 4;
    corner.castShadow = true;
    boardGroup.add(corner);
  });

  const markerMeshes = buildMoveMarkers(boardGroup);

  scene.add(boardGroup);
  return { boardGroup, tileMeshes, markerMeshes };
}

// Unlit overlay markers for move highlighting, drawn on top of the tiles
// rather than tinting the tile material — the marble texture/veining and
// scene lighting were making the old emissive-tint approach hard to read.
const SELECT_RING_COLOR = 0xc4953a;
const MOVE_DOT_COLOR = 0x9a1414; // dark red — clearly reads as "you can move/attack here"

function buildMoveMarkers(boardGroup) {
  const ringGeo = new THREE.RingGeometry(0.32, 0.4, 32);
  const dotGeo = new THREE.CircleGeometry(0.15, 24);

  const markerMeshes = {};

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const square = FILES[file] + (rank + 1);
      const pos = squareToPosition(square);

      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: SELECT_RING_COLOR, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.015, pos.z);
      ring.visible = false;
      boardGroup.add(ring);

      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({
        color: MOVE_DOT_COLOR, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(pos.x, 0.016, pos.z);
      dot.visible = false;
      boardGroup.add(dot);

      markerMeshes[square] = { ring, dot };
    }
  }

  return markerMeshes;
}

export function showSelectMarker(markerMeshes, square) {
  const m = markerMeshes[square];
  if (m) m.ring.visible = true;
}

export function showMoveMarkers(markerMeshes, squares) {
  for (const sq of squares) {
    const m = markerMeshes[sq];
    if (m) m.dot.visible = true;
  }
}

export function clearHighlights(markerMeshes) {
  for (const sq in markerMeshes) {
    markerMeshes[sq].ring.visible = false;
    markerMeshes[sq].dot.visible = false;
  }
}
