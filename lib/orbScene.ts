import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface OrbSceneApi {
  /** Orbit the camera by the given angles (radians). */
  rotateBy(deltaTheta: number, deltaPhi: number): void;
  /** Multiply the camera's orbit radius by `factor` (<1 zooms in, >1 zooms out). */
  zoomBy(factor: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  dispose(): void;
}

const MIN_RADIUS = 2.4;
const MAX_RADIUS = 20;
const HOME_RADIUS = 6.5;
const HOME_THETA = Math.PI * 0.2;
const HOME_PHI = Math.PI / 2 - 0.3;
const PHI_MARGIN = 0.15; // keep the camera from flipping over the poles

const CORE_COLOR = new THREE.Color(0x2fd8ff);
const CAGE_COLOR = 0x3fb0ff;
const BELT_COLOR = 0xaee9ff;
const STAR_COLOR = 0x8fbfff;

/** A glowing icosahedral core with a rim-light shader (no external light needed to read its edge). */
function createCore(): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(1.1, 6);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: CORE_COLOR } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-viewPos.xyz);
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      uniform vec3 uColor;
      void main() {
        float rim = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.4);
        gl_FragColor = vec4(uColor, rim * 0.85 + 0.07);
      }
    `,
  });
  return new THREE.Mesh(geometry, material);
}

interface Cage {
  mesh: THREE.LineSegments;
  spin: THREE.Vector3;
}

/** Nested icosahedral wireframes, each tumbling on its own slow, independent axis. */
function createCages(): Cage[] {
  const radii = [1.65, 2.25, 3.05];
  return radii.map((r) => {
    const edges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(r, 1));
    const material = new THREE.LineBasicMaterial({
      color: CAGE_COLOR,
      transparent: true,
      opacity: 0.32,
    });
    const mesh = new THREE.LineSegments(edges, material);
    const spin = new THREE.Vector3(
      (Math.random() - 0.5) * 0.09,
      0.02 + Math.random() * 0.05,
      (Math.random() - 0.5) * 0.07,
    );
    return { mesh, spin };
  });
}

interface BeltInstance {
  radius: number;
  speed: number;
  phase: number;
  wobble: number;
}

/** A ring of tumbling shards orbiting the core at varying radii and speeds. */
function createBelt(count: number): { mesh: THREE.InstancedMesh; instances: BeltInstance[] } {
  const geometry = new THREE.TetrahedronGeometry(0.035);
  const material = new THREE.MeshBasicMaterial({ color: BELT_COLOR });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const instances: BeltInstance[] = Array.from({ length: count }, () => ({
    radius: 3.8 + Math.random() * 2.6,
    speed: 0.12 + Math.random() * 0.3,
    phase: Math.random() * Math.PI * 2,
    wobble: (Math.random() - 0.5) * 0.7,
  }));
  return { mesh, instances };
}

function createStarfield(count: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 45 + Math.random() * 150;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: STAR_COLOR, size: 0.55, sizeAttenuation: true });
  return new THREE.Points(geometry, material);
}

export function createOrbScene(container: HTMLElement): OrbSceneApi {
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  // ——— manual spherical camera rig (no OrbitControls — driven entirely by rotateBy/zoomBy) ———
  let theta = HOME_THETA;
  let phi = HOME_PHI;
  let radius = HOME_RADIUS;

  function syncCamera(): void {
    const clampedPhi = Math.min(Math.PI - PHI_MARGIN, Math.max(PHI_MARGIN, phi));
    camera.position.set(
      radius * Math.sin(clampedPhi) * Math.sin(theta),
      radius * Math.cos(clampedPhi),
      radius * Math.sin(clampedPhi) * Math.cos(theta),
    );
    camera.lookAt(0, 0, 0);
  }
  syncCamera();

  // ——— lighting ———
  scene.add(new THREE.AmbientLight(0x1a2a4a, 0.55));
  const keyLight = new THREE.PointLight(0x4fd8ff, 5.5, 40, 2);
  keyLight.position.set(4, 3, 4);
  scene.add(keyLight);
  const coreLight = new THREE.PointLight(0x8be9ff, 3, 6, 2);
  scene.add(coreLight);

  // ——— geometry ———
  const core = createCore();
  scene.add(core);

  const cages = createCages();
  for (const cage of cages) scene.add(cage.mesh);

  const BELT_COUNT = 220;
  const { mesh: belt, instances: beltInstances } = createBelt(BELT_COUNT);
  scene.add(belt);

  const stars = createStarfield(900);
  scene.add(stars);

  // ——— post-processing: bloom only, kept deliberately simple ———
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 1.35, 0.55, 0.18);
  composer.addPass(bloom);

  // ——— pointer input: single-pointer drag spins, two-pointer pinch zooms ———
  const DRAG_ROTATE_SPEED = 0.006; // radians per pixel
  const activePointers = new Map<number, { x: number; y: number }>();
  let dragPointerId: number | null = null;
  let lastDrag: { x: number; y: number } | null = null;
  let lastPinchDist: number | null = null;

  function pinchDistance(): number {
    const [a, b] = Array.from(activePointers.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(e: PointerEvent): void {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    renderer.domElement.setPointerCapture(e.pointerId);
    if (activePointers.size === 1) {
      dragPointerId = e.pointerId;
      lastDrag = { x: e.clientX, y: e.clientY };
    } else if (activePointers.size === 2) {
      dragPointerId = null;
      lastDrag = null;
      lastPinchDist = pinchDistance();
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      const dist = pinchDistance();
      if (lastPinchDist) {
        radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius * (lastPinchDist / dist)));
        syncCamera();
      }
      lastPinchDist = dist;
      return;
    }

    if (dragPointerId === e.pointerId && lastDrag) {
      theta -= (e.clientX - lastDrag.x) * DRAG_ROTATE_SPEED;
      phi -= (e.clientY - lastDrag.y) * DRAG_ROTATE_SPEED;
      syncCamera();
      lastDrag = { x: e.clientX, y: e.clientY };
    }
  }

  function onPointerUp(e: PointerEvent): void {
    activePointers.delete(e.pointerId);
    if (dragPointerId === e.pointerId) {
      dragPointerId = null;
      lastDrag = null;
    }
    if (activePointers.size < 2) lastPinchDist = null;
    if (activePointers.size === 1) {
      const [[id, pt]] = activePointers;
      dragPointerId = id;
      lastDrag = pt;
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius * Math.exp(e.deltaY * 0.0015)));
    syncCamera();
  }

  renderer.domElement.style.touchAction = "none";
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  // ——— animation ———
  const timer = new THREE.Timer();
  const dummy = new THREE.Object3D();
  let rafId = 0;

  function tick(): void {
    rafId = requestAnimationFrame(tick);
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();

    core.rotation.y += dt * 0.15;
    core.rotation.x += dt * 0.03;

    for (const cage of cages) {
      cage.mesh.rotation.x += cage.spin.x * dt;
      cage.mesh.rotation.y += cage.spin.y * dt;
      cage.mesh.rotation.z += cage.spin.z * dt;
    }

    for (let i = 0; i < beltInstances.length; i++) {
      const inst = beltInstances[i];
      const angle = inst.phase + t * inst.speed;
      dummy.position.set(
        Math.cos(angle) * inst.radius,
        Math.sin(angle * 1.7 + inst.phase) * inst.wobble,
        Math.sin(angle) * inst.radius,
      );
      dummy.rotation.set(angle, angle * 0.6, angle * 0.3);
      dummy.updateMatrix();
      belt.setMatrixAt(i, dummy.matrix);
    }
    belt.instanceMatrix.needsUpdate = true;

    stars.rotation.y += dt * 0.005;

    composer.render();
  }
  tick();

  function handleResize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", handleResize);

  return {
    rotateBy(deltaTheta, deltaPhi) {
      theta -= deltaTheta;
      phi -= deltaPhi;
      syncCamera();
    },
    zoomBy(factor) {
      radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius * factor));
      syncCamera();
    },
    zoomIn() {
      radius = Math.max(MIN_RADIUS, radius * 0.85);
      syncCamera();
    },
    zoomOut() {
      radius = Math.min(MAX_RADIUS, radius * 1.18);
      syncCamera();
    },
    resetView() {
      theta = HOME_THETA;
      phi = HOME_PHI;
      radius = HOME_RADIUS;
      syncCamera();
    },
    dispose() {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      core.geometry.dispose();
      (core.material as THREE.Material).dispose();
      for (const cage of cages) {
        cage.mesh.geometry.dispose();
        (cage.mesh.material as THREE.Material).dispose();
      }
      belt.geometry.dispose();
      (belt.material as THREE.Material).dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
