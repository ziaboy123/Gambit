import * as THREE from 'three';
import { createPieceMesh } from './pieces.js';
import { squareToPosition } from './board.js';

const MOVE_DURATION = 320; // ms — non-capture move, and the approach leg of a capture
const APPROACH_FRACTION = 0.6; // how far toward the target the attacker closes before striking
const STEP_IN_DURATION = 160; // ms — final short step onto the now-vacated square
const WALK_DURATION = 340; // ms
const DEATH_FALLBACK_MS = 500; // used when a piece has no Death clip (the rook)
const DEATH_HOLD_MS = 200; // hold at the death pose before sinking away
const DEATH_FADE_MS = 320;
const ATTACK_FALLBACK_MS = 380; // used when a piece has no attack clip (the rook)

function playOnce(mixer, clip) {
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  return action;
}

function crossfadeToIdle(mixer, fromAction, idleClip, delayMs) {
  if (!idleClip) return;
  setTimeout(() => {
    const idleAction = mixer.clipAction(idleClip);
    idleAction.reset().play();
    fromAction.crossFadeTo(idleAction, 0.25, false);
  }, delayMs);
}

function setOpacity(root, opacity) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((mat) => {
      mat.transparent = true;
      mat.opacity = opacity;
    });
  });
}

export class PieceManager {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'pieces';
    scene.add(this.group);
    this.meshes = new Map(); // square -> mesh
    this.animations = []; // active tweens
    this.mixers = new Set();
    this.facingLocks = new Set();
    this.lastTick = null;
  }

  buildFromBoard(chess) {
    this.group.clear();
    this.meshes.clear();
    this.mixers.clear();
    this.facingLocks.clear();
    const board = chess.board();
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        const mesh = createPieceMesh(cell.type, cell.color);
        const pos = squareToPosition(cell.square);
        mesh.position.set(pos.x, 0, pos.z);
        this.group.add(mesh);
        this.meshes.set(cell.square, mesh);
        this._trackPiece(mesh);
      }
    }
  }

  _trackPiece(mesh) {
    if (mesh.userData.mixer) this.mixers.add(mesh.userData.mixer);
    if (mesh.userData.facingLock) this.facingLocks.add(mesh.userData.facingLock);
  }

  _untrackPiece(mesh) {
    if (mesh.userData.mixer) this.mixers.delete(mesh.userData.mixer);
    if (mesh.userData.facingLock) this.facingLocks.delete(mesh.userData.facingLock);
  }

  getMeshAt(square) {
    return this.meshes.get(square) || null;
  }

  // Animates a move already applied to chess.js. `moveResult` is chess.js's
  // Move object. `callbacks.onComplete()` fires once the piece has fully
  // settled; `callbacks.onCaptureImpact(worldPos)` fires the moment a strike
  // lands (only for captures) so the caller can sync a camera cut to it.
  animateMove(moveResult, callbacks = {}) {
    const { onComplete, onCaptureImpact } = callbacks;
    const { from, to, captured, promotion, flags } = moveResult;
    const movingMesh = this.meshes.get(from);
    if (!movingMesh) { onComplete?.(); return; }

    this.meshes.delete(from);

    // Handle en-passant capture (captured pawn isn't on `to`).
    let capturedSquare = null;
    if (captured) {
      capturedSquare = flags.includes('e') // en passant
        ? to[0] + from[1]
        : to;
    }

    let capturedMesh = null;
    if (capturedSquare && capturedSquare !== to) {
      capturedMesh = this.meshes.get(capturedSquare);
      this.meshes.delete(capturedSquare);
    } else if (captured) {
      capturedMesh = this.meshes.get(to);
      this.meshes.delete(to);
    }

    // Castling: rook also needs to move.
    let rookAnim = null;
    if (flags.includes('k') || flags.includes('q')) {
      const rank = from[1];
      const rookFrom = flags.includes('k') ? `h${rank}` : `a${rank}`;
      const rookTo = flags.includes('k') ? `f${rank}` : `d${rank}`;
      const rookMesh = this.meshes.get(rookFrom);
      if (rookMesh) {
        this.meshes.delete(rookFrom);
        this.meshes.set(rookTo, rookMesh);
        rookAnim = { mesh: rookMesh, to: rookTo };
      }
    }

    this.meshes.set(to, movingMesh);

    const startPos = movingMesh.position.clone();
    const endPos = squareToPosition(to);
    const startTime = performance.now();

    if (capturedMesh) {
      this._animateAttackSequence(movingMesh, capturedMesh, startPos, endPos, startTime, {
        onCaptureImpact,
        onSettled: () => {
          if (promotion) this._replaceWithPromotion(to, promotion, movingMesh);
          onComplete?.();
        },
      });
    } else {
      this._animateWalk(movingMesh, startTime);
      this.animations.push({
        update: (t) => {
          const p = Math.min(t / MOVE_DURATION, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          movingMesh.position.x = startPos.x + (endPos.x - startPos.x) * eased;
          movingMesh.position.z = startPos.z + (endPos.z - startPos.z) * eased;
          movingMesh.position.y = Math.sin(p * Math.PI) * 0.35;
          return p >= 1;
        },
        onDone: () => {
          movingMesh.position.set(endPos.x, 0, endPos.z);
          if (promotion) this._replaceWithPromotion(to, promotion, movingMesh);
          onComplete?.();
        },
        startTime,
      });
    }

    if (rookAnim) {
      const rStart = rookAnim.mesh.position.clone();
      const rEnd = squareToPosition(rookAnim.to);
      this.animations.push({
        update: (t) => {
          const p = Math.min(t / MOVE_DURATION, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          rookAnim.mesh.position.x = rStart.x + (rEnd.x - rStart.x) * eased;
          rookAnim.mesh.position.z = rStart.z + (rEnd.z - rStart.z) * eased;
          return p >= 1;
        },
        onDone: () => rookAnim.mesh.position.set(rEnd.x, 0, rEnd.z),
        startTime,
      });
    }

    return { capturedSquare: capturedMesh ? (capturedSquare || to) : null, from, to };
  }

  // Capture choreography: close the distance to just short of the target
  // square, strike (real attack clip or a procedural thrust for the rook)
  // while the defender dies in place, then step onto the now-vacated square
  // once the strike lands — instead of sliding straight on top of it.
  _animateAttackSequence(attacker, defender, startPos, endPos, startTime, { onCaptureImpact, onSettled }) {
    const engagePos = new THREE.Vector3().lerpVectors(startPos, endPos, APPROACH_FRACTION);
    const approachDuration = MOVE_DURATION * APPROACH_FRACTION;

    this.animations.push({
      update: (t) => {
        const p = Math.min(t / approachDuration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        attacker.position.x = startPos.x + (engagePos.x - startPos.x) * eased;
        attacker.position.z = startPos.z + (engagePos.z - startPos.z) * eased;
        attacker.position.y = Math.sin(p * Math.PI) * 0.3;
        return p >= 1;
      },
      onDone: () => {
        attacker.position.set(engagePos.x, 0, engagePos.z);
        const impactTime = performance.now();

        const strikeMs = this._triggerAttack(attacker, impactTime);
        this._animateDeath(defender, impactTime);
        onCaptureImpact?.(endPos.clone());

        this.animations.push({
          update: (t) => {
            if (t < strikeMs) return false;
            const p = Math.min((t - strikeMs) / STEP_IN_DURATION, 1);
            const eased = 1 - Math.pow(1 - p, 2);
            attacker.position.x = engagePos.x + (endPos.x - engagePos.x) * eased;
            attacker.position.z = engagePos.z + (endPos.z - engagePos.z) * eased;
            return p >= 1;
          },
          onDone: () => {
            attacker.position.set(endPos.x, 0, endPos.z);
            onSettled?.();
          },
          startTime: impactTime,
        });
      },
      startTime,
    });
  }

  // Plays the attacker's real attack clip if it has one (procedural thrust
  // for the rook otherwise) and returns how long the strike takes, in ms.
  _triggerAttack(mesh, startTime) {
    const mixer = mesh.userData.mixer;
    const clips = mesh.userData.clips;
    if (mixer && clips?.attack) {
      const action = playOnce(mixer, clips.attack);
      const durationMs = clips.attack.duration * 1000;
      crossfadeToIdle(mixer, action, clips.idle, durationMs);
      return durationMs;
    }
    this._animateProceduralThrust(mesh, startTime);
    return ATTACK_FALLBACK_MS;
  }

  _animateWalk(mesh, startTime) {
    const mixer = mesh.userData.mixer;
    const clips = mesh.userData.clips;
    if (mixer && clips?.run) {
      const action = playOnce(mixer, clips.run);
      crossfadeToIdle(mixer, action, clips.idle, WALK_DURATION);
    }
  }

  // Plays a death animation on the captured piece (its real Death clip if it
  // has one, otherwise a procedural topple for the rook), holds briefly on
  // the final pose, then fades and sinks it out.
  _animateDeath(mesh, startTime) {
    const mixer = mesh.userData.mixer;
    const clips = mesh.userData.clips;
    this._untrackPiece(mesh); // stop facing-lock so it can fall freely; keep mixer if present

    let deathMs = DEATH_FALLBACK_MS;

    if (mixer && clips?.death) {
      this.mixers.add(mixer); // keep ticking through the death clip
      playOnce(mixer, clips.death);
      deathMs = clips.death.duration * 1000;
    } else {
      // Procedural topple (rook, or a model with no Death clip).
      const startRot = mesh.rotation.z;
      const targetRot = startRot + (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 2 - 0.15);
      this.animations.push({
        update: (t) => {
          const p = Math.min(t / DEATH_FALLBACK_MS, 1);
          const eased = 1 - Math.pow(1 - p, 2);
          mesh.rotation.z = startRot + (targetRot - startRot) * eased;
          mesh.position.y = Math.max(0, mesh.position.y - 0.01);
          return p >= 1;
        },
        startTime,
      });
    }

    const startPos = mesh.position.clone();
    const startScale = mesh.scale.x;
    const sinkStart = deathMs + DEATH_HOLD_MS;

    this.animations.push({
      update: (t) => {
        if (t < sinkStart) return false;
        const p = Math.min((t - sinkStart) / DEATH_FADE_MS, 1);
        setOpacity(mesh, 1 - p);
        mesh.position.y = startPos.y - p * 0.5;
        mesh.scale.setScalar(startScale * (1 - p * 0.3));
        return p >= 1;
      },
      onDone: () => {
        this.mixers.delete(mixer);
        this.group.remove(mesh);
      },
      startTime,
    });
  }

  // The rook has no rig to play an attack animation, so it gets a quick
  // forward lean + scale punch instead — a small stand-in for a swing.
  _animateProceduralThrust(mesh, startTime) {
    this.animations.push({
      update: (t) => {
        const p = Math.min(t / ATTACK_FALLBACK_MS, 1);
        const bump = Math.sin(p * Math.PI);
        mesh.scale.set(1 + bump * 0.06, 1 - bump * 0.04, 1 + bump * 0.06);
        return p >= 1;
      },
      onDone: () => mesh.scale.setScalar(1),
      startTime,
    });
  }

  _replaceWithPromotion(square, promotion, oldMesh) {
    const color = oldMesh.userData.pieceColor;
    this._untrackPiece(oldMesh);
    this.group.remove(oldMesh);
    const mesh = createPieceMesh(promotion, color);
    const pos = squareToPosition(square);
    mesh.position.set(pos.x, 0, pos.z);
    const targetScale = mesh.scale.x || 1;
    mesh.scale.setScalar(0.001);
    this.group.add(mesh);
    this.meshes.set(square, mesh);
    this._trackPiece(mesh);
    const startTime = performance.now();
    this.animations.push({
      update: (t) => {
        const p = Math.min(t / 260, 1);
        mesh.scale.setScalar(Math.max(targetScale * p, 0.001));
        return p >= 1;
      },
      onDone: () => mesh.scale.setScalar(targetScale),
      startTime,
    });
  }

  tick(now) {
    const delta = this.lastTick == null ? 0 : (now - this.lastTick) / 1000;
    this.lastTick = now;
    for (const mixer of this.mixers) mixer.update(delta);

    // Neutralize any root-motion rotation/position the animation clips
    // apply to the character's own transform — bone-level motion (limbs,
    // breathing) still plays normally, only the root is pinned.
    for (const lock of this.facingLocks) {
      lock.root.rotation.y = lock.rotationY;
      lock.root.position.copy(lock.position);
    }

    if (!this.animations.length) return;
    // Not a plain filter: an onDone callback (promotion pop-in, the capture
    // sequence's next phase, a death fade-out) commonly pushes a brand new
    // animation onto this.animations while we're mid-iteration. Reassigning
    // `this.animations = this.animations.filter(...)` would silently drop
    // anything pushed during that pass — filter snapshots the array length
    // up front, then we'd overwrite the live (mutated) array with a stale
    // result that never saw the new entries. Draining into a fresh array
    // instead means every push, whenever it happens, lands somewhere real.
    const pending = this.animations;
    this.animations = [];
    for (const anim of pending) {
      const done = anim.update(now - anim.startTime);
      if (done) {
        anim.onDone?.();
      } else {
        this.animations.push(anim);
      }
    }
  }

  isAnimating() {
    return this.animations.length > 0;
  }
}
