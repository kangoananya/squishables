// Headless kernel check: runs every node-graph preset, verifies the output has
// no NaNs and reports timings. `--js` measures the JS kernel instead of Rust.
import { readFileSync } from 'node:fs';
import { initWasm } from '../src/kernel/wasm.js';
import { runGraph } from '../src/kernel/graph.js';
import { toRenderBuffers, toSTL } from '../src/kernel/export.js';
import { GRAPH_PRESETS, toCompiled } from '../src/graph-presets.js';

const useJs = process.argv.includes('--js');
if (!useJs) await initWasm(readFileSync(new URL('../wasm/squishables_kernel.wasm', import.meta.url)));
console.log(`kernel: ${useJs ? 'js' : 'rust/wasm'}`);

for (const preset of GRAPH_PRESETS) {
  const t0 = performance.now();
  const { buf, warning } = runGraph(toCompiled(preset), { maxFaces: 10e6 });
  const t1 = performance.now();
  const r = toRenderBuffers(buf, false);
  const t2 = performance.now();
  const bad = r.position.some(Number.isNaN);
  const stl = toSTL(buf);
  console.log(
    `${preset.name.padEnd(48)} ${String(buf.nFaces).padStart(9)} faces  eval ${(t1 - t0).toFixed(0).padStart(5)} ms  ` +
    `render-buf ${(t2 - t1).toFixed(0).padStart(4)} ms  stl ${(stl.byteLength / 1e6).toFixed(1)} MB` +
    `${bad ? '  NaN!' : ''}${warning ? '  ' + warning : ''}`,
  );
}
