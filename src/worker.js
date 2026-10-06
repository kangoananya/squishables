import { runGraph } from './kernel/graph.js';
import { toRenderBuffers, toEdges, toContours, toPoints, toSTL, toOBJ } from './kernel/export.js';
import { initWasm } from './kernel/wasm.js';

// Rust/WASM kernel when available, the JS kernel otherwise (same results)
// (worker.js?kernel=js forces the JS kernel, for comparisons)
const kernel = (new URL(import.meta.url).searchParams.get('kernel') === 'js'
  ? Promise.reject(new Error('JS kernel requested'))
  : initWasm(new URL('../wasm/squishables_kernel.wasm', import.meta.url))).then(
  () => 'rust/wasm',
  (err) => { console.warn('squishables: WASM kernel unavailable, using JS', err); return 'js'; },
);

const EDGE_LIMIT = 2_000_000; // wireframe up to this many faces
// node outputs survive between previews, so an edit only recomputes downstream
const graphCache = new Map();

// last full result, reused when only the selected node changed (results that
// hit the face limit aren't in the node cache, so this avoids re-running them)
let last = { key: null, buf: null, warning: null };

function evaluate(job, maxFaces, cache) {
  if (!cache) return runGraph(job.data, { maxFaces });
  const { selected, ...rest } = job.data;
  const key = JSON.stringify(rest) + maxFaces;
  if (key !== last.key) {
    const r = runGraph({ ...rest, selected: null }, { maxFaces, cache });
    last = { key, buf: r.buf, warning: r.warning };
  }
  // the highlight is skipped for runs that hit the limit: it could re-run them
  const sel = selected != null && !last.warning ? runGraph({ ...rest, outputs: [], selected }, { maxFaces, cache, evict: false }).selected : null;
  return { buf: last.buf, warning: last.warning, selected: sel };
}

self.onmessage = async (e) => {
  const { id, type, job, maxFaces, format, display = {} } = e.data;
  const kernelName = await kernel;
  try {
    const t0 = performance.now();
    const { buf, warning, selected } = evaluate(job, maxFaces, type === 'preview' ? graphCache : null);
    const evalMs = performance.now() - t0;

    if (type === 'preview') {
      const mode = display.mode ?? 'shaded';
      const wantEdges = mode === 'wire'; // edges are only drawn as wireframe
      const r = toRenderBuffers(buf, wantEdges && buf.nFaces < EDGE_LIMIT);
      const highlight = selected && selected.nFaces < 300_000 ? toEdges(selected) : null;
      const contours = mode === 'contours' || mode === 'shaded+contours'
        ? toContours(buf, { axis: display.contourAxis, density: display.contourDensity })
        : null;
      const points = mode === 'points' ? toPoints(buf, { count: display.pointCount, seed: job.data?.seed }) : null;
      const transfer = [r.position.buffer, r.index.buffer, r.color.buffer];
      if (r.edges) transfer.push(r.edges.buffer);
      if (highlight) transfer.push(highlight.buffer);
      if (contours) transfer.push(contours.buffer);
      if (points) transfer.push(points.position.buffer, points.color.buffer);
      self.postMessage({
        id, type, position: r.position, index: r.index, color: r.color, edges: r.edges, highlight, contours, points,
        stats: { faces: buf.nFaces, tris: r.tris, tagCounts: r.tagCounts, evalMs, totalMs: performance.now() - t0, warning, kernel: kernelName,
          edgesSkipped: wantEdges && buf.nFaces >= EDGE_LIMIT },
      }, transfer);
    } else if (type === 'export') {
      const data = format === 'obj' ? toOBJ(buf) : toSTL(buf);
      self.postMessage({ id, type, format, data, warning }, typeof data === 'string' ? [] : [data]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message });
  }
};
