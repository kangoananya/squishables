// Shared app shell for both editors (blocks and nodes): three.js viewport,
// evaluation worker, status/legend, and the top toolbar. The page supplies
// getJob() → { kind: 'program' | 'graph', data } and calls refresh().

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TAGS, TAG_COLORS } from './kernel/mesh.js';
import { loadDisplay, buildViewPanel, currentBackground, backgroundCss, paintBackground, inkFor } from './display.js';

export const $ = (sel) => document.querySelector(sel);

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function createApp({ getJob, emptyHint = '' }) {
  const view = { colorMode: 'normal', edges: true, maxFaces: 2_000_000 };
  let faceCount = 0;
  const params = new URLSearchParams(location.search);
  const display = loadDisplay();
  // ?display=contours&bg=paper override the saved view (handy for sharing links)
  if (params.get('display')) display.mode = params.get('display');
  if (params.get('bg')) display.background = params.get('bg');
  const app = { seed: 1, onSeedChange: null };

  // ---------------------------------------------------------------- viewport
  const viewport = $('#viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewport.prepend(renderer.domElement);

  // no ground and a transparent canvas over a CSS gradient: the object floats
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(4, -5, 3.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.8);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a44, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, -2, 6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7);
  fill.position.set(-4, 3, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffc8e8, 1.6);
  rim.position.set(-2, 5, -3);
  scene.add(rim);

  // flat shading is derived per pixel on the GPU, so no normals are uploaded;
  // the polygon offset keeps overlaid lines (edges, contours) from z-fighting
  const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const materials = {
    tag: new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, flatShading: true, ...offset }),
    clay: new THREE.MeshStandardMaterial({ color: 0xd9d4ca, side: THREE.DoubleSide, roughness: 0.9, flatShading: true, ...offset }),
    normal: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, flatShading: true, ...offset }),
  };
  // invisible surface that only hides what is behind it (hidden-line views)
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, ...offset });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials.tag);
  scene.add(mesh);
  const edgeLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  scene.add(edgeLines);
  const contourLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true }));
  scene.add(contourLines);
  const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, sizeAttenuation: false }));
  scene.add(cloud);
  // Grasshopper-style highlight of the selected node's output
  const highlight = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xff1493, transparent: true, opacity: 0.9, depthTest: false }),
  );
  highlight.renderOrder = 1;
  scene.add(highlight);

  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = viewport;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(viewport);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  function frameMesh() {
    const s = mesh.geometry.boundingSphere;
    if (!s || !s.radius) return;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(s.center);
    camera.position.copy(s.center).addScaledVector(dir, (s.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.1);
  }

  // ---------------------------------------------------------------- worker
  let worker = null;
  let busy = false;
  let pending = false;
  let busySince = 0;
  let reqId = 0;
  let frameNext = true;

  function spawnWorker() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => { busy = false; setStatus(`Worker error: ${e.message || 'out of memory?'}`, true); };
  }
  spawnWorker();

  // Edits queue behind a running evaluation (only the latest is kept), so a
  // long evaluation always finishes; the Stop button is the explicit way out.
  function refresh() {
    if (busy) { pending = true; return; }
    busy = true;
    pending = false;
    busySince = performance.now();
    setStatus('computing…');
    tickBusy();
    const { mode, contourAxis, contourDensity, pointCount } = display;
    worker.postMessage({
      id: ++reqId, type: 'preview', job: getJob(), maxFaces: view.maxFaces, edges: view.edges,
      display: { mode, contourAxis, contourDensity, pointCount },
    });
  }

  // after a moment, show elapsed time and a Stop button
  let ticking = false;
  function tickBusy() {
    if (ticking) return;
    ticking = true;
    (function tick() {
      if (!busy) { ticking = false; $('#stop').hidden = true; return; }
      const s = (performance.now() - busySince) / 1000;
      if (s > 0.8) {
        $('#status').textContent = `computing… ${s.toFixed(1)} s`;
        $('#stop').hidden = false;
      }
      setTimeout(tick, 200);
    })();
  }

  function stop() {
    if (!busy) return;
    worker.terminate(); // also drops the worker's node cache
    spawnWorker();
    busy = false;
    pending = false;
    $('#stop').hidden = true;
    setStatus('stopped — lower the face limit or the depth, or edit to run again', false);
  }

  function onWorkerMessage(e) {
    const m = e.data;
    if (m.id !== reqId) return;
    busy = false;
    if (m.type === 'error') setStatus(`Error: ${m.message}`, true);
    else if (m.type === 'preview') showPreview(m);
    if (pending) refresh();
  }

  function showPreview(m) {
    const positions = new THREE.BufferAttribute(m.position, 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', positions);
    g.setAttribute('color', new THREE.BufferAttribute(m.color, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.computeBoundingSphere();
    mesh.geometry.dispose();
    mesh.geometry = g;

    // outlines share the mesh's position buffer, only adding an index
    edgeLines.geometry.dispose();
    edgeLines.geometry = new THREE.BufferGeometry();
    if (m.edges) {
      edgeLines.geometry.setAttribute('position', positions);
      edgeLines.geometry.setIndex(new THREE.BufferAttribute(m.edges, 1));
    }
    contourLines.geometry.dispose();
    contourLines.geometry = new THREE.BufferGeometry();
    if (m.contours) contourLines.geometry.setAttribute('position', new THREE.BufferAttribute(m.contours, 3));

    cloud.geometry.dispose();
    cloud.geometry = new THREE.BufferGeometry();
    if (m.points) {
      cloud.geometry.setAttribute('position', new THREE.BufferAttribute(m.points.position, 3));
      cloud.geometry.setAttribute('color', new THREE.BufferAttribute(m.points.color, 3, true));
    }

    highlight.geometry.dispose();
    highlight.geometry = new THREE.BufferGeometry();
    if (m.highlight) highlight.geometry.setAttribute('position', new THREE.BufferAttribute(m.highlight, 3));

    faceCount = m.stats.faces;
    applyDisplay();
    if (frameNext && m.stats.faces) { frameMesh(); frameNext = false; }
    const s = m.stats;
    if (s.edgesSkipped) s.warning = [s.warning, 'Edges / wireframe are only drawn below 2,000,000 faces.'].filter(Boolean).join(' ');
    setStatus(
      s.faces || !emptyHint
        ? `${s.faces.toLocaleString()} faces · ${s.tris.toLocaleString()} tris · ${s.evalMs.toFixed(0)} ms eval / ${s.totalMs.toFixed(0)} ms total · ${s.kernel}`
        : emptyHint,
      false, s.warning,
    );
    renderLegend(s.tagCounts);
  }

  function exportMesh(format) {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    setStatus(`exporting ${format.toUpperCase()}…`);
    w.onmessage = (e) => {
      w.terminate();
      const m = e.data;
      if (m.type === 'error') return setStatus(`Export failed: ${m.message}`, true);
      download(new Blob([m.data], { type: format === 'obj' ? 'text/plain' : 'model/stl' }), `squishables.${format}`);
      setStatus(`exported squishables.${format}`, false, m.warning);
    };
    w.postMessage({ id: 0, type: 'export', job: getJob(), maxFaces: view.maxFaces * 4, format });
  }

  function setStatus(text, isError = false, warning = null) {
    $('#status').textContent = text;
    $('#status').classList.toggle('error', isError);
    $('#warning').textContent = warning ?? '';
  }

  function renderLegend(counts = []) {
    $('#legend').replaceChildren(...TAGS.map((t, i) => {
      const chip = el('span', { class: 'chip' + (counts[i] ? '' : ' empty') }, el('i'), `${t} ${counts[i] ? counts[i].toLocaleString() : ''}`);
      chip.firstChild.style.background = TAG_COLORS[i];
      return chip;
    }));
  }

  function setColorMode(mode) {
    if (!materials[mode]) return;
    view.colorMode = mode;
    $('#color').value = mode;
    $('#legend').hidden = mode !== 'tag'; // tag colours only matter in that mode
    applyDisplay();
  }

  // ---------------------------------------------------------------- display
  function applyDisplay() {
    const { mode, hiddenLines } = display;
    const bg = currentBackground(display);
    const ink = inkFor(bg);
    viewport.style.background = backgroundCss(bg);
    viewport.style.setProperty('--hud', ink);

    const hasEdges = !!edgeLines.geometry.index;
    // a wireframe too big to draw falls back to the shaded surface
    const wire = mode === 'wire' && hasEdges;
    const surface = mode === 'shaded' || mode === 'shaded+contours' || (mode === 'wire' && !hasEdges);
    mesh.visible = surface || hiddenLines;
    mesh.material = surface ? materials[view.colorMode] : depthOnly;

    // dense meshes would turn solid, so lines fade as the face count grows
    const density = Math.min(1, Math.sqrt(40_000 / Math.max(1, faceCount)));
    edgeLines.visible = hasEdges && (wire || (surface && view.edges));
    edgeLines.material.color.set(wire ? ink : '#000000');
    edgeLines.material.opacity = wire ? Math.max(0.12, 0.9 * density) : Math.max(0.06, 0.35 * density);

    contourLines.visible = mode.includes('contours');
    contourLines.material.color.set(surface ? '#141416' : ink);
    contourLines.material.opacity = surface ? 0.55 : 0.95;

    cloud.visible = mode === 'points';
    cloud.material.size = display.pointSize * Math.min(devicePixelRatio, 2);
  }

  function savePng() {
    const canvas = renderer.domElement;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    paintBackground(ctx, out.width, out.height, currentBackground(display));
    renderer.render(scene, camera); // draw now so the buffer is still valid
    ctx.drawImage(canvas, 0, 0);
    out.toBlob((blob) => download(blob, 'squishables.png'), 'image/png');
  }

  const viewPanel = buildViewPanel(display, (kind) => {
    if (kind === 'geometry') refresh();
    else if (kind === 'png') savePng();
    else applyDisplay();
  });
  viewport.append(viewPanel);
  const viewButton = el('button', { id: 'view-toggle', title: 'display mode & background' }, '/view/');
  viewButton.addEventListener('click', () => { viewPanel.hidden = !viewPanel.hidden; viewButton.classList.toggle('on', !viewPanel.hidden); });
  viewport.append(viewButton);

  // ---------------------------------------------------------------- toolbar
  $('#seed').addEventListener('change', () => { app.seed = $('#seed').value | 0; app.onSeedChange?.(); refresh(); });
  $('#reseed').addEventListener('click', () => {
    app.seed = (Math.random() * 1e6) | 0;
    $('#seed').value = app.seed;
    app.onSeedChange?.();
    refresh();
  });
  $('#color').addEventListener('change', (e) => setColorMode(e.target.value));
  $('#edges').addEventListener('change', (e) => { view.edges = e.target.checked; refresh(); });
  $('#limit').addEventListener('change', (e) => { view.maxFaces = +e.target.value; refresh(); });
  $('#export-stl').addEventListener('click', () => exportMesh('stl'));
  $('#export-obj').addEventListener('click', () => exportMesh('obj'));
  $('#frame').addEventListener('click', frameMesh);
  $('#stop').addEventListener('click', stop);
  addEventListener('keydown', (e) => {
    if (e.key === 'f' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) frameMesh();
  });

  // draggable split between editor and viewport
  $('#splitter').addEventListener('pointerdown', (e) => {
    const sp = e.currentTarget;
    sp.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const pct = Math.min(80, Math.max(25, (ev.clientX / innerWidth) * 100));
      document.body.style.setProperty('--left', `${pct}%`);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', () => sp.removeEventListener('pointermove', move), { once: true });
  });

  setColorMode(params.get('color'));
  applyDisplay();
  renderLegend();

  return Object.assign(app, {
    refresh,
    setStatus,
    frameOnNextResult: () => { frameNext = true; },
    setSeed(s) { app.seed = s | 0; $('#seed').value = app.seed; },
    params,
  });
}
