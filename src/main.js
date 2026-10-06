/* global LiteGraph, LGraph, LGraphCanvas */
// squishables: node editor + viewport.
import { NODE_TYPES } from './kernel/nodes.js';
import { GRAPH_PRESETS } from './graph-presets.js';
import { createApp, $, el, download } from './viewer.js';
import { ACCENT, CATEGORY_COLORS, LINK_COLORS } from './palette.js';

const STORAGE_KEY = 'squishables.graph.v1';

const MONO = "'Roboto Mono', ui-monospace, monospace";

let current = { seed: 1, nodes: {}, outputs: [] };
let selectedId = null;

const app = createApp({
  getJob: () => ({ kind: 'graph', data: current }),
  emptyHint: 'Connect something to an Output node',
});

// ---------------------------------------------------------------- node types
LiteGraph.clearRegisteredTypes();
const typeKey = {};
for (const [key, def] of Object.entries(NODE_TYPES)) {
  const lgType = `${def.cat}/${key}`;
  typeKey[lgType] = key;
  function MeshNode() {
    for (const [name, type] of def.inputs) this.addInput(name, type);
    for (const [name, type] of def.outputs) this.addOutput(name, type);
    for (const [name, spec] of Object.entries(def.params)) addParamWidget(this, name, spec);
    this.applyTheme();
    this.shape = LiteGraph.BOX_SHAPE;
    this.serialize_widgets = true; // otherwise saved graphs lose every value
    this.size = this.computeSize();
    this.fitWidth();
  }
  MeshNode.title = def.title.toLowerCase();
  MeshNode.prototype.applyTheme = function () {
    this.color = CATEGORY_COLORS[def.cat].title;
    this.bgcolor = '#ffffff';
    this.boxcolor = CATEGORY_COLORS[def.cat].box;
  };
  // colours come from the theme, not the file: graphs saved under an older
  // theme would otherwise bring their node colours back on load
  // graphs saved with smaller type would clip their labels, so widen them
  MeshNode.prototype.fitWidth = function () { this.size[0] = Math.max(this.size[0], this.computeSize()[0], 240); };
  MeshNode.prototype.onConfigure = function () { this.applyTheme(); this.fitWidth(); };
  MeshNode.prototype.onSerialize = function (o) { delete o.color; delete o.bgcolor; delete o.boxcolor; };
  // LiteGraph only outlines selected nodes; on white every node needs an edge
  MeshNode.prototype.onDrawForeground = function (ctx) {
    if (this.flags.collapsed || this.is_selected) return;
    const th = LiteGraph.NODE_TITLE_HEIGHT;
    ctx.strokeStyle = '#cfcfcf';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, -th + 0.5, this.size[0] - 1, this.size[1] + th - 1);
  };
  LiteGraph.registerNodeType(lgType, MeshNode);
}

// values are read by compile() polling, so widget callbacks have nothing to do
const noop = () => {};
function addParamWidget(node, name, spec) {
  if (spec.type === 'bool') node.addWidget('toggle', name, spec.value, noop);
  else if (spec.type === 'enum') node.addWidget('combo', name, spec.value, noop, { values: spec.options });
  // LiteGraph moves number widgets by step * 0.1, hence the * 10
  else node.addWidget('number', name, spec.value, noop, { min: spec.min, max: spec.max, step: spec.step * 10, precision: spec.step >= 1 ? 0 : 2 });
}

// LiteGraph evaluates typed values as JS, so a decimal comma ("0,8") would
// become 8 via the comma operator; accept it as a decimal point instead
const prompt = LGraphCanvas.prototype.prompt;
LGraphCanvas.prototype.prompt = function (title, value, callback, ...rest) {
  const decimalComma = (v) => (typeof v === 'string' ? v.trim().replace(/^(-?\d*),(\d+)$/, '$1.$2') : v);
  return prompt.call(this, title, value, (v) => callback(decimalComma(v)), ...rest);
};

// LiteGraph draws the selected node's wires in hard-coded white, which
// vanishes on the white canvas; draw them in the accent instead
const renderLink = LGraphCanvas.prototype.renderLink;
LGraphCanvas.prototype.renderLink = function (ctx, a, b, link, skipBorder, flow, color, ...rest) {
  if (link == null || !this.highlighted_links[link.id]) return renderLink.call(this, ctx, a, b, link, skipBorder, flow, color, ...rest);
  delete this.highlighted_links[link.id];
  try { return renderLink.call(this, ctx, a, b, link, skipBorder, flow, ACCENT, ...rest); }
  finally { this.highlighted_links[link.id] = true; }
};

LiteGraph.NODE_TEXT_SIZE = 15; // used to size nodes to their titles
LiteGraph.NODE_TITLE_COLOR = '#111111';
LiteGraph.NODE_SELECTED_TITLE_COLOR = '#000000';
LiteGraph.NODE_TEXT_COLOR = '#5c5c5c';
LiteGraph.NODE_BOX_OUTLINE_COLOR = ACCENT; // selection outline
LiteGraph.WIDGET_BGCOLOR = '#f4f4f4';
LiteGraph.WIDGET_OUTLINE_COLOR = '#dcdcdc';
LiteGraph.WIDGET_TEXT_COLOR = '#222222';
LiteGraph.WIDGET_SECONDARY_TEXT_COLOR = '#8a8a8a';
LiteGraph.NODE_DEFAULT_SHAPE = 'box';
LiteGraph.LINK_COLOR = LINK_COLORS.faces;
Object.assign(LGraphCanvas.link_type_colors, LINK_COLORS);

// ---------------------------------------------------------------- canvas
const graph = new LGraph();
const lgc = new LGraphCanvas($('#graph-canvas'), graph);
window.squishables = { graph, canvas: lgc }; // handle for debugging from the console
lgc.render_canvas_border = false;
lgc.show_info = false;
lgc.title_text_font = `15px ${MONO}`;
lgc.inner_text_font = `13px ${MONO}`;
// canvas text only uses the web font once it has loaded
document.fonts?.load(`15px ${MONO}`).then(() => lgc.setDirty(true, true));
lgc.clear_background_color = '#ffffff';
lgc.render_shadows = false;
lgc.render_connections_border = false;
lgc.default_connection_color = { input_off: '#c4c4c4', input_on: '#5c5c5c', output_off: '#c4c4c4', output_on: '#5c5c5c' };
lgc.default_connection_color_byType = { condition: LINK_COLORS.condition, loop: LINK_COLORS.loop };
// coarse grid, drawn as lines (LiteGraph's image-pattern background can be
// cached before the image decodes and then shows as a grey wash)
const GRID = 100;
lgc.background_image = null;
lgc.onDrawBackground = (ctx, area) => {
  const [x, y, w, h] = area;
  ctx.save();
  ctx.strokeStyle = '#dedede';
  ctx.lineWidth = 1 / lgc.ds.scale; // one screen pixel at any zoom
  ctx.beginPath();
  for (let gx = Math.floor(x / GRID) * GRID; gx <= x + w; gx += GRID) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
  for (let gy = Math.floor(y / GRID) * GRID; gy <= y + h; gy += GRID) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
  ctx.stroke();
  ctx.restore();
};
lgc.onSelectionChange = (nodes) => {
  const ids = Object.keys(nodes ?? {});
  selectedId = ids.length === 1 ? Number(ids[0]) : null;
};
let fitPending = false;
new ResizeObserver(() => {
  const r = $('#graph').getBoundingClientRect();
  if (!r.width || !r.height) return;
  lgc.resize(Math.floor(r.width), Math.floor(r.height));
  if (fitPending) fitView();
}).observe($('#graph'));

// fits all nodes into view; deferred until the canvas has its real size
function fitView() {
  const nodes = graph._nodes;
  const r = $('#graph').getBoundingClientRect();
  if (!nodes.length || Math.abs($('#graph-canvas').width - Math.floor(r.width)) > 1) { fitPending = true; return; }
  fitPending = false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1] - LiteGraph.NODE_TITLE_HEIGHT);
    x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]);
  }
  const { width: w, height: h } = $('#graph-canvas');
  const pad = 40;
  // never zoom out: text stays legible, a wider graph is anchored at its left edge
  const scale = 1;
  const fitsX = (x1 - x0) * scale <= w - pad * 2;
  lgc.ds.scale = scale;
  lgc.ds.offset = [
    fitsX ? (w / scale - (x1 - x0)) / 2 - x0 : pad / scale - x0,
    Math.max(pad / scale, (h / scale - (y1 - y0)) / 2) - y0,
  ];
  lgc.setDirty(true, true);
}

// ---------------------------------------------------------------- graph → evaluator
const roundTo = (v, step) => (step >= 1 ? Math.round(v) : +(Math.round(v / step) * step).toFixed(6));

function compile() {
  const nodes = {};
  const outputs = [];
  for (const node of graph._nodes) {
    const key = typeKey[node.type];
    if (!key || node.mode === LiteGraph.NEVER) continue;
    const def = NODE_TYPES[key];
    const params = {};
    for (const w of node.widgets ?? []) {
      const spec = def.params[w.name];
      if (!spec) continue;
      if (spec.type === 'number') {
        // typed values aren't range-checked by LiteGraph: clamp, and show it
        let v = Number(w.value);
        v = Number.isFinite(v) ? roundTo(Math.min(spec.max, Math.max(spec.min, v)), spec.step) : spec.value;
        if (v !== w.value) { w.value = v; lgc.setDirty(true); }
        params[w.name] = v;
      } else {
        params[w.name] = w.value;
      }
    }
    const inputs = {};
    for (const input of node.inputs ?? []) {
      const link = input.link != null ? graph.links[input.link] : null;
      const src = link && graph.getNodeById(link.origin_id);
      if (src && src.mode !== LiteGraph.NEVER) inputs[input.name] = [link.origin_id, src.outputs[link.origin_slot].name];
    }
    nodes[node.id] = { type: key, params, inputs };
    if (key === 'output') outputs.push(node.id);
  }
  return { seed: app.seed, nodes, outputs, selected: selectedId };
}

// LiteGraph has no single "changed" event, so watch the compiled graph
let last = '';
setInterval(() => {
  const next = compile();
  const s = JSON.stringify(next);
  if (s === last) return;
  last = s;
  current = next;
  save();
  app.refresh();
}, 120);

// ---------------------------------------------------------------- documents
function loadPreset(p) {
  graph.clear();
  const made = {};
  for (const nd of p.nodes) {
    const def = NODE_TYPES[nd.type];
    const node = LiteGraph.createNode(`${def.cat}/${nd.type}`);
    node.pos = [nd.pos[0] * 1.1, nd.pos[1]]; // room for the node titles
    for (const w of node.widgets ?? []) if (nd.params[w.name] !== undefined) w.value = nd.params[w.name];
    graph.add(node);
    made[nd.id] = node;
  }
  for (const [from, fromSlot, to, toSlot] of p.links) {
    const a = made[from], b = made[to];
    a.connect(a.findOutputSlot(fromSlot), b, b.findInputSlot(toSlot));
  }
  app.setSeed(p.seed ?? 1);
  app.frameOnNextResult();
  fitView();
}

function loadSaved(data) {
  graph.configure(data.graph);
  app.setSeed(data.seed ?? 1);
  app.frameOnNextResult();
  fitView();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ seed: app.seed, graph: graph.serialize() }));
  } catch { /* storage unavailable */ }
}
addEventListener('beforeunload', save);

$('#preset').append(...GRAPH_PRESETS.map((p, i) => el('option', { value: i }, p.name.toLowerCase())));
$('#preset').addEventListener('change', (e) => {
  if (e.target.value !== '') loadPreset(GRAPH_PRESETS[+e.target.value]);
  e.target.value = '';
});
$('#new-doc').addEventListener('click', () => loadPreset({
  seed: 1,
  nodes: [{ id: 1, type: 'box', pos: [80, 120], params: {} }, { id: 2, type: 'output', pos: [380, 120], params: {} }],
  links: [[1, 'faces', 2, 'faces']],
}));
$('#save-json').addEventListener('click', () => {
  const data = { format: 'squishables-graph', version: 1, seed: app.seed, graph: graph.serialize() };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'squishables-graph.json');
});
$('#load-json').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.graph) throw new Error('not a squishables graph file');
    loadSaved(data);
  } catch (err) {
    app.setStatus(`Could not load: ${err.message}`, true);
  }
});

// ---------------------------------------------------------------- boot
requestAnimationFrame(() => {
  const presetParam = GRAPH_PRESETS[app.params.get('preset')];
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* ignore */ }
  if (presetParam) loadPreset(presetParam);
  else if (stored?.graph) {
    try { loadSaved(stored); } catch { loadPreset(GRAPH_PRESETS[0]); }
  } else loadPreset(GRAPH_PRESETS[0]);
});
