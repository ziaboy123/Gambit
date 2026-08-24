import * as THREE from 'three';

const APPROACH_MS = 420;
const HOLD_MS = 550;
const RETURN_MS = 550;

// Cuts the camera to a close, dramatic angle on a capture, then eases back
// to the player's previous orbit position. Disables OrbitControls for the duration.
export class CinematicCamera {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.active = false;
  }

  playCapture(worldPos, onDone) {
    if (this.active) { onDone?.(); return; }
    this.active = true;
    this.controls.enabled = false;

    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();

    const dir = new THREE.Vector3().subVectors(startPos, startTarget).normalize();
    const closePos = worldPos.clone()
      .add(dir.clone().multiplyScalar(2.6))
      .add(new THREE.Vector3(0, 1.1, 0));

    const phases = [
      { duration: APPROACH_MS, from: startPos, to: closePos, targetFrom: startTarget, targetTo: worldPos },
      { duration: HOLD_MS, from: closePos, to: closePos, targetFrom: worldPos, targetTo: worldPos },
      { duration: RETURN_MS, from: closePos, to: startPos, targetFrom: worldPos, targetTo: startTarget },
    ];

    let phaseIndex = 0;
    let phaseStart = performance.now();

    const step = (now) => {
      const phase = phases[phaseIndex];
      const t = Math.min((now - phaseStart) / phase.duration, 1);
      const eased = 1 - Math.pow(1 - t, 2);

      this.camera.position.lerpVectors(phase.from, phase.to, eased);
      this.controls.target.lerpVectors(phase.targetFrom, phase.targetTo, eased);
      this.camera.lookAt(this.controls.target);

      if (t >= 1) {
        phaseIndex++;
        phaseStart = now;
        if (phaseIndex >= phases.length) {
          this.controls.target.copy(startTarget);
          this.controls.enabled = true;
          this.active = false;
          onDone?.();
          return;
        }
      }
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }
}
