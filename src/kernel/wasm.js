// Bridge to the Rust kernel (kernel-rs → wasm/squishables_kernel.wasm).
// Plain C ABI: buffers are copied into wasm memory, the operation runs, and
// the result is copied back out into an ordinary FaceBuffer. When the module
// isn't loaded, callers fall back to the JS implementation.

import { FaceBuffer, FaceLimit } from './mesh.js';

let wasm = null;
let module = null; // kept to start a fresh instance after a trap
let enabled = true;

// `source`: a URL (browser) or the module bytes (Node)
export async function initWasm(source) {
  let result;
  if (source instanceof URL || typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${response.status} loading ${source}`);
    try {
      result = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      // some hosts serve .wasm without the application/wasm type streaming needs
      result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
  } else {
    result = await WebAssembly.instantiate(source, {});
  }
  module = result.module;
  wasm = result.instance.exports;
}

export const useWasm = () => enabled && wasm !== null;
export function setWasmEnabled(on) { enabled = on; }

export function wasmCatmullClark(src, maxFaces, w, salt) {
  const nV = src.nVerts, nF = src.nFaces;
  const hasVid = !!(src.vid && src.nUnique);
  const topo = hasVid ? src.edges : null;
  const nE = topo ? topo.a.length : 0;
  // [bytes, view type, source, length] per input array
  const inputs = [
    [Float32Array, src.pos, nV * 3],
    [Uint32Array, src.start, nF],
    [Uint8Array, src.count, nF],
    [Uint8Array, src.tag, nF],
    [Uint32Array, hasVid ? src.vid : null, nV],
    [Uint32Array, topo?.cornerEdge, nV],
    [Uint32Array, topo?.a, nE],
    [Uint32Array, topo?.b, nE],
    [Uint16Array, topo?.ef, nE],
  ].map(([Type, data, len]) => ({ Type, data, len, bytes: data ? len * Type.BYTES_PER_ELEMENT : 0 }));
  for (const inp of inputs) inp.ptr = inp.bytes ? wasm.mm_alloc(inp.bytes) >>> 0 : 0;
  // views are created after all allocations: allocating can grow (and detach) memory
  const mem = wasm.memory.buffer;
  for (const { Type, data, len, ptr, bytes } of inputs) if (bytes) new Type(mem, ptr, len).set(data.subarray(0, len));

  const p = inputs.map((i) => i.ptr);
  let status;
  try {
    status = wasm.mm_catmull_clark(
      p[0], nV, p[1], p[2], p[3], nF, p[4], hasVid ? src.nUnique : 0,
      p[5], p[6], p[7], p[8], nE,
      w.vertex ?? 1, w.edge ?? 1, w.face ?? 0, w.ridge ?? 0, w.variation ?? 0, w.frequency ?? 2,
      salt | 0, Math.min(maxFaces, 0xffffffff) >>> 0,
    );
  } catch (e) {
    // a failed allocation aborts the module ("unreachable"); its memory stays
    // grown and its allocator state is unknown, so start over with a fresh one
    if (e instanceof WebAssembly.RuntimeError) wasm = new WebAssembly.Instance(module, {}).exports;
    throw e;
  }
  for (const { ptr, bytes } of inputs) if (bytes) wasm.mm_free(ptr, bytes);
  if (status === 1) throw new FaceLimit();

  const out = new FaceBuffer(0, 0);
  const take = (which, Type) => new Type(wasm.memory.buffer, wasm.mm_out_ptr(which) >>> 0, wasm.mm_out_len(which)).slice();
  out.pos = take(0, Float32Array);
  out.start = take(1, Uint32Array);
  out.count = take(2, Uint8Array);
  out.tag = take(3, Uint8Array);
  out.vid = take(4, Uint32Array);
  out.edges = { cornerEdge: take(5, Uint32Array), a: take(6, Uint32Array), b: take(7, Uint32Array), ef: take(8, Uint16Array) };
  out.nUnique = wasm.mm_out_len(9);
  out.nFaces = out.start.length;
  out.nVerts = out.pos.length / 3;
  wasm.mm_out_clear();
  return out;
}
