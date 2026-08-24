import * as THREE from 'three';

export class Picker {
  constructor(camera, domElement, pickables) {
    this.camera = camera;
    this.domElement = domElement;
    this.pickables = pickables; // array of THREE.Object3D to test against
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  // Returns the `square` userData string of the topmost hit, or null.
  pickSquare(event) {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const hit of hits) {
      let obj = hit.object;
      while (obj) {
        if (obj.userData?.square) return obj.userData.square;
        obj = obj.parent;
      }
    }
    return null;
  }
}
