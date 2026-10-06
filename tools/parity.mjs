// Checks the Rust/WASM Catmull–Clark against the JS reference on every graph
// preset plus random weight sets: same topology, positions within float eps.
import { readFileSync } from 'node:fs';
import { initWasm, setWasmEnabled } from '../src/kernel/wasm.js';
import { runGraph } from '../src/kernel/graph.js';
import { GRAPH_PRESETS, toCompiled } from '../src/graph-presets.js';
import { chain, sub } from '../src/graph-chain.js';

await initWasm(readFileSync(new URL('../wasm/squishables_kernel.wasm', import.meta.url)));

const rnd = (a, b) => a + Math.random() * (b - a);
const random = Array.from({ length: 4 }, (_, i) => chain(`random weights ${i}`, i, { solid: ['cube', 'icosidodecahedron', 'tetrahedron', 'truncated octahedron'][i], radius: 1 }, [
  { loop: 2, body: [sub(rnd(-1, 2), rnd(0, 2), rnd(-0.6, 0.6), { ridge: rnd(-0.3, 0.3), variation: rnd(0, 1), frequency: rnd(0.5, 4) })] },
]));

let worst = 0;
for (const preset of [...GRAPH_PRESETS, ...random]) {
  const g = toCompiled(preset);
  setWasmEnabled(false);
  let t = performance.now();
  const js = runGraph(structuredClone(g), { maxFaces: 5e6 }).buf;
  const tJs = performance.now() - t;
  setWasmEnabled(true);
  t = performance.now();
  const rs = runGraph(structuredClone(g), { maxFaces: 5e6 }).buf;
  const tRs = performance.now() - t;
  let diff = js.nFaces === rs.nFaces && js.nVerts === rs.nVerts ? 0 : Infinity;
  for (let i = 0; i < js.nVerts * 3 && diff !== Infinity; i++) diff = Math.max(diff, Math.abs(js.pos[i] - rs.pos[i]));
  let tags = 0;
  for (let f = 0; f < Math.min(js.nFaces, rs.nFaces); f++) if (js.tag[f] !== rs.tag[f] || js.count[f] !== rs.count[f]) tags++;
  worst = Math.max(worst, diff);
  console.log(`${preset.name.padEnd(48)} ${String(js.nFaces).padStart(8)} faces  max |Δ| ${diff.toExponential(1).padStart(8)}  tag/count mismatches ${tags}  js ${tJs.toFixed(0).padStart(5)} ms  wasm ${tRs.toFixed(0).padStart(5)} ms`);
}
console.log(worst < 1e-4 ? 'PARITY OK' : 'PARITY FAILED');
