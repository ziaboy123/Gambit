import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateNightSky, generateSkyGradient, generateStoneTexture } from './textures.js';
import { THEMES } from './themes.js';

function buildSkydome(scene, theme) {
  const tex = theme.sky.type === 'night'
    ? generateNightSky(theme.sky.stops, 5, 1024)
    : generateSkyGradient(theme.sky.stops, 4, 1024);
  const geo = new THREE.SphereGeometry(55, 24, 16);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false });
  const dome = new THREE.Mesh(geo, mat);
  scene.add(dome);
}

function buildFloor(scene, theme) {
  const tex = generateStoneTexture(theme.floorColor, 91, 512);
  tex.repeat.set(10, 10);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.03 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), mat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.52;
  floor.receiveShadow = true;
  scene.add(floor);
}

export function setupScene(canvas, theme = THEMES[0]) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog.color, theme.fog.density);
  buildSkydome(scene, theme);
  buildFloor(scene, theme);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 8.5, 8.5);
  camera.position.copy(DEFAULT_CAMERA_POS);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  // Soft studio-style environment reflections — no external HDR needed.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.045).texture;
  pmrem.dispose();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  // Scene lighting — colors/intensities come from the chosen board theme;
  // rig (positions) stays fixed since it's tuned to the board/camera layout.
  const { ambient: ambientCfg, key: keyCfg, rim: rimCfg, glowA: glowACfg, glowB: glowBCfg } = theme.lights;

  const ambient = new THREE.AmbientLight(ambientCfg.color, ambientCfg.intensity);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(keyCfg.color, keyCfg.intensity);
  keyLight.position.set(6, 10, 4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -8;
  keyLight.shadow.camera.right = 8;
  keyLight.shadow.camera.top = 8;
  keyLight.shadow.camera.bottom = -8;
  keyLight.shadow.bias = -0.0015;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(rimCfg.color, rimCfg.intensity);
  rimLight.position.set(-5, 4, -8);
  scene.add(rimLight);

  const torchA = new THREE.PointLight(glowACfg.color, glowACfg.intensity, 11, 2);
  torchA.position.set(-5.6, 2.6, -5.6);
  scene.add(torchA);

  const torchB = new THREE.PointLight(glowBCfg.color, glowBCfg.intensity, 11, 2);
  torchB.position.set(5.6, 2.6, 5.6);
  scene.add(torchB);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.12, // strength
    0.35, // radius
    0.96  // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, controls, composer, defaultCameraPos: DEFAULT_CAMERA_POS };
}

// Puts the camera on a given color's side of the board — so a player
// assigned black in an online game looks at the board from black's side
// rather than always defaulting to white's view.
export function orientCameraForColor(camera, controls, defaultCameraPos, color) {
  if (color === 'b') {
    camera.position.set(defaultCameraPos.x, defaultCameraPos.y, -defaultCameraPos.z);
  } else {
    camera.position.copy(defaultCameraPos);
  }
  controls.target.set(0, 0, 0);
  controls.update();
}
