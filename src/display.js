// Display settings for the viewport: render mode, contour / point-cloud
// options and background gradients, with the View panel that edits them.
// Backgrounds are data, so the same gradient can be shown as CSS behind the
// transparent WebGL canvas and painted into an exported PNG.

const STORAGE_KEY = 'squishables.view.v1';

export const MODES = [
  ['shaded', 'Shaded'],
  ['shaded+contours', 'Shaded + contours'],
  ['contours', 'Contour lines'],
  ['points', 'Point cloud'],
  ['wire', 'Wireframe'],
];

export const BACKGROUNDS = {
  dusk: { label: 'Dusk', type: 'linear', angle: 160, stops: [[0, '#2a2338'], [0.55, '#171a24'], [1, '#0e1418']] },
  night: { label: 'Night', type: 'radial', stops: [[0, '#232a3a'], [1, '#05060a']] },
  studio: { label: 'Studio', type: 'radial', stops: [[0, '#ffffff'], [0.6, '#e2dfda'], [1, '#b9b5ae']] },
  paper: { label: 'Paper', type: 'solid', stops: [[0, '#f5f3ee']] },
  blueprint: { label: 'Blueprint', type: 'linear', angle: 160, stops: [[0, '#1a4f8f'], [1, '#081a33']] },
  sunset: { label: 'Sunset', type: 'linear', angle: 170, stops: [[0, '#ffb37a'], [0.45, '#d9607e'], [1, '#33244f']] },
  mint: { label: 'Mint', type: 'linear', angle: 180, stops: [[0, '#eef8f3'], [1, '#93cdb8']] },
  ember: { label: 'Ember', type: 'radial', stops: [[0, '#5a2a1a'], [0.6, '#24120d'], [1, '#0b0605']] },
};

export const DEFAULT_DISPLAY = {
  mode: 'shaded',
  contourAxis: 'z',
  contourCount: 80,
  pointCount: 200_000,
  pointSize: 1.5,
  hiddenLines: true,
  background: 'dusk',
  custom: { a: '#3a2d5c', b: '#0d1117', angle: 160, radial: false },
};

export function loadDisplay() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...DEFAULT_DISPLAY, ...stored, custom: { ...DEFAULT_DISPLAY.custom, ...stored?.custom } };
  } catch {
    return structuredClone(DEFAULT_DISPLAY);
  }
}

export function saveDisplay(d) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- backgrounds

export function currentBackground(d) {
  if (d.background !== 'custom') return BACKGROUNDS[d.background] ?? BACKGROUNDS.dusk;
  const { a, b, angle, radial } = d.custom;
  return { label: 'Custom', type: radial ? 'radial' : 'linear', angle, stops: [[0, a], [1, b]] };
}

export function backgroundCss(bg) {
  const stops = bg.stops.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(', ');
  if (bg.type === 'solid') return bg.stops[0][1];
  if (bg.type === 'radial') return `radial-gradient(ellipse at 50% 40%, ${stops})`;
  return `linear-gradient(${bg.angle}deg, ${stops})`;
}

// Same gradient on a 2D canvas (CSS angle convention: 0deg points up).
export function paintBackground(ctx, w, h, bg) {
  let fill;
  if (bg.type === 'solid') {
    fill = bg.stops[0][1];
  } else if (bg.type === 'radial') {
    // CSS "ellipse at 50% 40%" ends at the farthest corner
    const cx = w * 0.5, cy = h * 0.4;
    const rx = Math.max(cx, w - cx) * Math.SQRT2, ry = Math.max(cy, h - cy) * Math.SQRT2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    for (const [t, c] of bg.stops) g.addColorStop(t, c);
    ctx.fillStyle = g;
    ctx.fillRect(-cx, -cy * (rx / ry), w, h * (rx / ry));
    ctx.restore();
    return;
  } else {
    const a = (bg.angle * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
    for (const [t, c] of bg.stops) g.addColorStop(t, c);
    fill = g;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
}

// readable line / text colour for a background: dark ink on light ones
export function inkFor(bg) {
  const lum = bg.stops.reduce((sum, [, c]) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    return sum + 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }, 0) / bg.stops.length;
  return lum > 0.55 ? '#1d1d20' : '#f2efe8';
}

// ---------------------------------------------------------------- View panel

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

const row = (label, ...controls) => h('label', { class: 'vp-row' }, h('span', {}, label), ...controls);

function select(options, value, onChange) {
  const s = h('select');
  for (const [v, label] of options) s.append(h('option', { value: v }, label));
  s.value = String(value);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function range(min, max, step, value, onInput) {
  const r = h('input', { type: 'range', min, max, step });
  r.value = value;
  r.addEventListener('input', () => onInput(+r.value));
  return r;
}

// onChange(kind): 'geometry' needs new contours / points from the worker,
// 'look' only changes materials or the background, 'png' asks for an image
export function buildViewPanel(display, onChange) {
  const set = (kind, fn) => (v) => { fn(v); saveDisplay(display); render(); onChange(kind); };
  const panel = h('div', { id: 'view-panel', hidden: '' });

  function render() {
    const d = display;
    const contours = d.mode.includes('contours');
    const lines = contours || d.mode === 'wire' || d.mode === 'points';
    panel.replaceChildren(
      row('Display', select(MODES, d.mode, set('geometry', (v) => { d.mode = v; })))
    );
    if (contours) {
      panel.append(
        row('Slice', select([['z', 'height (z)'], ['x', 'x'], ['y', 'y'], ['radial', 'radial shells']], d.contourAxis, set('geometry', (v) => { d.contourAxis = v; }))),
        row('Lines', range(10, 300, 1, d.contourCount, set('geometry', (v) => { d.contourCount = v; })), h('output', {}, String(d.contourCount))),
      );
    }
    if (d.mode === 'points') {
      panel.append(
        row('Points', select([[50000, '50k'], [200000, '200k'], [500000, '500k'], [1000000, '1M'], [2000000, '2M']], d.pointCount, set('geometry', (v) => { d.pointCount = +v; }))),
        row('Size', range(0.5, 5, 0.1, d.pointSize, set('look', (v) => { d.pointSize = v; }))),
      );
    }
    if (lines) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = d.hiddenLines;
      cb.addEventListener('change', () => set('look', (v) => { d.hiddenLines = v; })(cb.checked));
      panel.append(row('Hide hidden', cb));
    }

    const swatches = h('div', { class: 'vp-swatches' });
    for (const [key, bg] of Object.entries(BACKGROUNDS)) {
      const b = h('button', { class: 'vp-swatch' + (d.background === key ? ' on' : ''), title: bg.label });
      b.style.background = backgroundCss(bg);
      b.addEventListener('click', () => set('look', () => { d.background = key; })());
      swatches.append(b);
    }
    const custom = h('button', { class: 'vp-swatch custom' + (d.background === 'custom' ? ' on' : ''), title: 'Custom' }, '+');
    custom.style.background = backgroundCss(currentBackground({ ...d, background: 'custom' }));
    custom.addEventListener('click', () => set('look', () => { d.background = 'custom'; })());
    swatches.append(custom);
    panel.append(h('div', { class: 'vp-title' }, 'Background'), swatches);

    if (d.background === 'custom') {
      const color = (key) => {
        const c = h('input', { type: 'color' });
        c.value = d.custom[key];
        c.addEventListener('input', () => set('look', () => { d.custom[key] = c.value; })());
        return c;
      };
      const radial = h('input', { type: 'checkbox' });
      radial.checked = d.custom.radial;
      radial.addEventListener('change', () => set('look', () => { d.custom.radial = radial.checked; })());
      panel.append(
        row('Colours', color('a'), color('b')),
        row('Angle', range(0, 360, 5, d.custom.angle, set('look', (v) => { d.custom.angle = v; }))),
        row('Radial', radial),
      );
    }
    panel.append(h('button', { class: 'vp-png', onclick: () => onChange('png') }, 'Save image (PNG)'));
  }

  render();
  return panel;
}
