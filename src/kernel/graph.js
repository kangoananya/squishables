// Evaluates a node graph (dataflow, Grasshopper-style). Each node is computed
// once and cached, except inside loops: a Loop End re-runs everything between
// it and its Loop Start `times` times, feeding its result back into the start.
//
// graph = { seed, outputs: [id], selected?: id,
//           nodes: { id: { type, params, inputs: { slot: [fromId, fromSlot] } } } }

import { FaceBuffer, TAG_INDEX } from './mesh.js';
import { OPS } from './ops.js';
import { buildPrimitive } from './primitives.js';
import { resolveParams } from './params.js';
import { NODE_TYPES } from './nodes.js';
import { applyGlobal, splitFaces, partition, compileCond, concat, mix, stop } from './apply.js';

const EMPTY = new FaceBuffer(1);

// `cache` (a Map kept by the caller between runs) makes evaluation
// incremental: a node whose key — its type, params and the keys of everything
// upstream — is unchanged returns its previous outputs without recomputing.
// Cached buffers are shared, so nodes must never mutate their inputs.
export function runGraph(graph, { maxFaces = 2e6, cache = null, evict = true } = {}) {
  const ctx = { maxFaces, work: 0, stopped: null };
  const keys = new Map();
  const nodes = graph.nodes ?? {};
  const seed = (graph.seed | 0) + 0x51ed;
  const rootMemo = new Map();
  const loopDeps = new Map();
  const visiting = new Set();

  // which Loop Starts a node's value depends on (decides where it is cached)
  function depsOf(id) {
    if (loopDeps.has(id)) return loopDeps.get(id);
    loopDeps.set(id, new Set()); // guards against cycles
    const n = nodes[id];
    const deps = new Set();
    if (n) {
      const def = NODE_TYPES[n.type];
      if (def?.kind === 'loop_start') deps.add(id);
      for (const [slot, [from]] of Object.entries(n.inputs ?? {})) {
        if (def?.kind === 'loop_end' && slot === 'loop') continue;
        for (const d of depsOf(from)) deps.add(d);
      }
      if (def?.kind === 'loop_end' && n.inputs?.loop) {
        const start = n.inputs.loop[0];
        deps.delete(start);
        const init = nodes[start]?.inputs?.faces;
        if (init) for (const d of depsOf(init[0])) deps.add(d);
      }
    }
    loopDeps.set(id, deps);
    return deps;
  }

  function keyOf(id) {
    if (keys.has(id)) return keys.get(id);
    keys.set(id, 'cycle');
    const n = nodes[id];
    let str = `${n?.type}|${JSON.stringify(n?.params ?? {})}|${id}|${seed}|${maxFaces}`;
    for (const [slot, [from, fromSlot]] of Object.entries(n?.inputs ?? {}).sort()) str += `|${slot}<${keyOf(from)}.${fromSlot}`;
    const key = hash(str);
    keys.set(id, key);
    return key;
  }

  function evalNode(id, scope) {
    const n = nodes[id];
    const def = n && NODE_TYPES[n.type];
    if (!def) return {};
    const deps = depsOf(id);
    let s = scope;
    while (s.parent && ![...deps].some((d) => s.overrides.has(d))) s = s.parent;
    if (s.memo.has(id)) return s.memo.get(id);
    // only loop-independent results (cached in the root scope) persist
    const persistent = cache && !s.parent;
    if (persistent) {
      const hit = cache.get(id);
      if (hit && hit.key === keyOf(id)) {
        s.memo.set(id, hit.out);
        return hit.out;
      }
    }
    if (visiting.has(id)) return {};
    visiting.add(id);
    const out = compute(id, n, def, scope);
    visiting.delete(id);
    s.memo.set(id, out);
    if (persistent && !ctx.stopped) cache.set(id, { key: keyOf(id), out });
    return out;
  }

  function input(n, slot, scope) {
    const link = n.inputs?.[slot];
    return link ? evalNode(link[0], scope)[link[1]] ?? null : null;
  }

  function faces(n, slot, scope) {
    const v = input(n, slot, scope);
    return v instanceof FaceBuffer ? v : EMPTY;
  }

  function compute(id, n, def, scope) {
    const p = resolveParams(def.params, n.params);
    const salt = mix(mix(seed, Number(id) || 0), scope.iter);
    if (ctx.stopped && def.kind !== 'output') return passThrough(n, def, scope);

    switch (def.kind) {
      case 'primitive':
        return { faces: buildPrimitive({ type: def.shape, params: p }) };

      case 'op': {
        const src = faces(n, 'faces', scope);
        const split = src.nFaces ? splitFaces(OPS[def.op], p, src, ctx, salt) : null;
        if (!split) return passThrough(n, def, scope);
        const out = {};
        for (const [slot, role] of Object.entries(def.roles)) {
          out[slot] = role === 'all' ? concat([split.pass, ...split.bufs]) : split.bufs[split.roles.indexOf(role)] ?? EMPTY;
        }
        return out;
      }

      case 'global': {
        const src = faces(n, 'faces', scope);
        return { faces: src.nFaces ? applyGlobal(OPS[def.op], p, src, ctx, salt) : src };
      }

      case 'filter': {
        const src = faces(n, 'faces', scope);
        const [yes, no] = partition(src, compileCond(input(n, 'condition', scope)), salt);
        return { yes, no };
      }

      case 'cond':
        return { condition: { type: def.cond, ...p } };

      case 'combine':
        return { condition: { type: def.cond, a: input(n, 'a', scope), b: input(n, 'b', scope) } };

      case 'loop_start':
        return { faces: scope.overrides.get(id) ?? lookupOverride(scope, id) ?? faces(n, 'faces', scope), loop: id };

      case 'loop_end': {
        const link = n.inputs?.loop;
        if (!link || NODE_TYPES[nodes[link[0]]?.type]?.kind !== 'loop_start') return { faces: faces(n, 'faces', scope) };
        const startId = link[0];
        let cur = faces(nodes[startId], 'faces', scope);
        const times = Math.min(20, Math.max(0, Math.round(p.times)));
        for (let i = 0; i < times && !ctx.stopped; i++) {
          const inner = { parent: scope, memo: new Map(), overrides: new Map([[startId, cur]]), iter: mix(scope.iter, i + 1) };
          cur = faces(n, 'faces', inner);
        }
        return { faces: cur };
      }

      case 'merge':
        return { faces: concat(def.inputs.map(([slot]) => faces(n, slot, scope))) };

      case 'tag': {
        const out = copy(faces(n, 'faces', scope));
        const t = TAG_INDEX[p.tag];
        if (t !== undefined) out.tag.fill(t, 0, out.nFaces);
        return { faces: out };
      }

      case 'move': {
        const out = copy(faces(n, 'faces', scope));
        const d = [p.x, p.y, p.z];
        for (let v = 0; v < out.nVerts; v++) for (let k = 0; k < 3; k++) out.pos[v * 3 + k] += d[k];
        return { faces: out };
      }

      case 'output':
        return { faces: faces(n, 'faces', scope) };
    }
    return {};
  }

  // once the face limit is hit, downstream nodes forward their input unchanged
  function passThrough(n, def, scope) {
    const src = def.inputs.length ? faces(n, def.inputs[0][0], scope) : EMPTY;
    return Object.fromEntries(def.outputs.map(([slot]) => [slot, src]));
  }

  function lookupOverride(scope, id) {
    for (let s = scope; s; s = s.parent) if (s.overrides.has(id)) return s.overrides.get(id);
    return null;
  }

  const root = { parent: null, memo: rootMemo, overrides: new Map(), iter: 0 };
  const buf = concat((graph.outputs ?? []).map((id) => evalNode(id, root).faces ?? EMPTY));
  let selected = null;
  if (graph.selected != null && nodes[graph.selected]) {
    const out = evalNode(graph.selected, root);
    selected = Object.values(out).find((v) => v instanceof FaceBuffer) ?? null;
  }
  // drop cached outputs of nodes that are gone, stale or no longer evaluated
  if (cache && evict) for (const [id, hit] of cache) if (keys.get(id) !== hit.key) cache.delete(id);
  return { buf: buf === EMPTY ? new FaceBuffer(1) : buf, selected, warning: ctx.stopped };
}

// cyrb53: short stable hash for cache keys
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function copy(src) {
  return new FaceBuffer(src.nFaces + 1, src.nVerts + 1).append(src);
}
