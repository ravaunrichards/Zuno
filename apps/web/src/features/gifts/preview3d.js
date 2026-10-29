import * as THREE from 'three';

const SHAPES = Object.freeze({
  sphere: () => new THREE.SphereGeometry(0.38, 18, 12),
  box: () => new THREE.BoxGeometry(0.62, 0.62, 0.62),
  cone: () => new THREE.ConeGeometry(0.42, 0.85, 18),
  torus: () => new THREE.TorusGeometry(0.48, 0.13, 10, 24),
  icosahedron: () => new THREE.IcosahedronGeometry(0.48, 1),
  cylinder: () => new THREE.CylinderGeometry(0.34, 0.34, 0.75, 18),
  tetrahedron: () => new THREE.TetrahedronGeometry(0.55, 0)
});
const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const specCache = new Map();
const groupCache = new Map();

function buildModelGroup(giftId, spec) {
  const group = new THREE.Group();
  group.name = giftId;
  group.userData.giftId = giftId;
  const parts = Array.isArray(spec.parts) ? spec.parts.slice(0, 32) : [];
  parts.forEach((part, index) => {
    if (!part || !SHAPES[part.shape]) return;
    const geometry = SHAPES[part.shape]();
    const material = new THREE.MeshStandardMaterial({
      color: /^#[0-9a-f]{6}$/i.test(String(part.color || '')) ? part.color : '#9a7cff',
      metalness: Math.max(0, Math.min(1, Number(part.metalness) || 0)),
      roughness: Math.max(0.05, Math.min(1, Number(part.roughness) || 0.65)),
      emissive: /^#[0-9a-f]{6}$/i.test(String(part.color || '')) ? part.color : '#000000',
      emissiveIntensity: 0.08
    });
    const mesh = new THREE.Mesh(geometry, material);
    const scale = Math.max(0.05, Math.min(2.5, Number(part.scale) || 1));
    mesh.scale.setScalar(scale);
    const position = Array.isArray(part.position) ? part.position : [0, 0, 0];
    mesh.position.set(
      Math.max(-1.25, Math.min(1.25, Number(position[0]) || 0)),
      Math.max(-1.25, Math.min(1.25, Number(position[1]) || 0)),
      Math.max(-1.25, Math.min(1.25, Number(position[2]) || 0))
    );
    mesh.rotation.set(index * 0.31, index * 0.67, index * 0.19);
    group.add(mesh);
  });
  if (!group.children.length) throw new Error('MODEL_HAS_NO_SUPPORTED_PARTS');
  group.userData.animation = spec.animation || {};
  return group;
}

export function mountGiftPreviews(grid) {
  if (!grid || grid.dataset.giftRendererMounted === 'true') return { refresh() {} };
  grid.dataset.giftRendererMounted = 'true';
  grid.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.className = 'gift-preview-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  grid.append(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: 'low-power',
      preserveDrawingBuffer: false
    });
  } catch (_) {
    grid.classList.add('gift-preview-unavailable');
    canvas.remove();
    return { refresh() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.7));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(3, 4, 6);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x8e7bff, 3.4, 18);
  rimLight.position.set(-3, 1.5, -2);
  scene.add(rimLight);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
  camera.position.set(0, 0.25, 6.3);
  camera.lookAt(0, 0, 0);
  let destroyed = false;
  let frame = 0;
  let lastFrame = 0;
  const rotations = new Map();

  async function ensureModel(card) {
    const id = card.dataset.giftId;
    const modelPath = card.dataset.modelPath;
    if (!id || !modelPath || groupCache.has(id) || specCache.has(id)) return;
    specCache.set(id, 'loading');
    try {
      const url = new URL(modelPath.replace(/^\//, ''), document.baseURI);
      const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!response.ok) throw new Error('MODEL_FETCH_FAILED');
      const spec = await response.json();
      if (spec.format !== 'procedural-geometry-spec-v1' || !Array.isArray(spec.parts)) throw new Error('MODEL_FORMAT_INVALID');
      const group = buildModelGroup(id, spec);
      group.visible = false;
      scene.add(group);
      groupCache.set(id, group);
      specCache.set(id, spec);
      card.querySelector('.gift-visual')?.classList.add('gift-3d-ready');
      card.querySelector('.gift-visual')?.setAttribute('aria-label', (card.dataset.giftName || 'ZUNO gift') + ', original procedural 3D preview');
    } catch (_) {
      specCache.delete(id);
      card.querySelector('.gift-visual')?.classList.add('gift-3d-fallback');
    }
  }

  function visibleCards() {
    return Array.from(grid.querySelectorAll('.gift-card[data-gift-id]'));
  }

  function refresh() {
    visibleCards().forEach(card => { void ensureModel(card); });
  }

  function render(now) {
    if (destroyed) return;
    frame = window.requestAnimationFrame(render);
    if (document.hidden || (now - lastFrame < 32)) return;
    lastFrame = now;
    const width = grid.clientWidth;
    const height = grid.clientHeight;
    if (width < 1 || height < 1) return;
    renderer.setSize(width, height, false);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const gridRect = grid.getBoundingClientRect();
    const cards = visibleCards();
    const visible = new Set(cards.map(card => card.dataset.giftId));
    for (const [id, group] of groupCache) group.visible = false;
    renderer.setScissorTest(true);
    renderer.clear();
    for (const card of cards) {
      const id = card.dataset.giftId;
      const group = groupCache.get(id);
      if (!group) continue;
      const visual = card.querySelector('.gift-visual');
      if (!visual) continue;
      const rect = visual.getBoundingClientRect();
      const x = rect.left - gridRect.left;
      const y = rect.top - gridRect.top;
      const w = rect.width;
      const h = rect.height;
      if (x + w < 0 || y + h < 0 || x > width || y > height || w < 1 || h < 1) continue;
      renderer.setViewport(x, height - y - h, w, h);
      renderer.setScissor(x, height - y - h, w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      group.visible = true;
      const spec = specCache.get(id);
      const animation = spec && spec.animation || {};
      const elapsed = reducedMotion ? 0 : now * 0.001;
      group.rotation.y = animation.spin ? elapsed * 0.45 + (id.length % 7) * 0.12 : 0.18;
      group.rotation.x = animation.spin ? Math.sin(elapsed * 0.4) * 0.12 : 0.05;
      group.position.y = animation.bob && !reducedMotion ? Math.sin(elapsed * 1.8) * 0.07 : 0;
      group.scale.setScalar(Math.min(1, Math.max(0.65, h / 100)));
      renderer.render(scene, camera);
      group.visible = false;
    }
    renderer.setScissorTest(false);
  }
  refresh();
  frame = window.requestAnimationFrame(render);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null;
  resizeObserver?.observe(grid);
  const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => refresh()) : null;
  mutationObserver?.observe(grid, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => {
    destroyed = true;
    window.cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    for (const group of groupCache.values()) {
      group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) Array.isArray(obj.material) ? obj.material.forEach(m => m.dispose()) : obj.material.dispose();
      });
    }
    groupCache.clear();
    renderer.dispose();
  }, { once: true });
  return { refresh };
}
