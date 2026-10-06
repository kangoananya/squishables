// Applying operations to face sets — the building blocks the node graph
// (graph.js) evaluates with: face ops split into per-role outputs, global ops
// (subdivision), filters with per-face conditions, and seeded randomness.
//
// cond = { type: 'facing', dir } | { type: 'chance', p } | { type: 'tag', tag }
//      | { type: 'size' | 'z', cmp: 'gt' | 'lt', value }
//      | { type: 'not', a } | { type: 'and' | 'or', a, b }

import { FaceBuffer, FaceLimit, TAG_INDEX } from './mesh.js';
import { OPS, newell, centroid } from './ops.js';

// faces routed into a role get this tag (roles not listed keep the parent's)
const ROLE_TAG = { cap: 'cap', side: 'side', apex: 'apex', frame: 'frame', inner: 'inner' };
const UP = Math.SQRT1_2;

const V = new Float64Array(256 * 3);
const Nrm = new Float64Array(3);
const Ctr = new Float64Array(3);

// mulberry32; reseeded per face from its node, loop iteration and index
let rs = 0;
function rnd() {
  rs = (rs + 0x6d2b79f5) | 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function mix(h, v) {
  h = Math.imul(h ^ v, 0x9e3779b1);
  return h ^ (h >>> 15);
}

const router = {
  bufs: null,
  tags: null,
  addFace(b, coords, n) { this.bufs[b].addFace(this.tags[b], coords, n); },
};

export function stop(ctx) {
  ctx.stopped ??= `Stopped early: over ${ctx.maxFaces.toLocaleString()} faces. Raise the face limit or reduce depth.`;
}

function account(ctx, produced) {
  ctx.work += produced;
  if (ctx.work > ctx.maxFaces * 4) stop(ctx);
}

export function applyGlobal(op, p, buf, ctx, salt = 0) {
  try {
    const out = op.applyAll(buf, p, ctx.maxFaces, salt);
    account(ctx, out.nFaces);
    return out;
  } catch (e) {
    if (e instanceof FaceLimit) stop(ctx);
    // wasm aborts ("unreachable") or a typed array that can't be allocated
    else if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
      ctx.stopped ??= `Ran out of memory subdividing ${buf.nFaces.toLocaleString()} faces. Set a face limit or reduce depth.`;
    } else throw e;
    return buf;
  }
}

// Applies a face op to every face; returns the new faces per output role plus
// the faces it couldn't apply to (pass), or null when the face limit is hit.
export function splitFaces(op, p, buf, ctx, salt) {
  const roles = Object.keys(op.outputs);
  const roleTags = roles.map((r) => (ROLE_TAG[r] ? TAG_INDEX[ROLE_TAG[r]] : -1));
  const o = {};
  roles.forEach((r, i) => { o[r] = i; });
  const cap = Math.min(buf.nFaces * 2 + 16, 1 << 16);
  const bufs = roles.map(() => new FaceBuffer(cap));
  const pass = new FaceBuffer(16);
  const tags = new Array(roles.length);
  const produced = () => bufs.reduce((sum, b) => sum + b.nFaces, 0);

  router.bufs = bufs;
  router.tags = tags;
  for (let f = 0; f < buf.nFaces; f++) {
    const n = buf.read(f, V);
    const t = buf.tag[f];
    for (let i = 0; i < roles.length; i++) tags[i] = roleTags[i] < 0 ? t : roleTags[i];
    rs = mix(salt, f);
    if (!op.apply(V, n, p, o, rnd, router)) pass.copyFace(buf, f);
    if ((f & 1023) === 1023 && produced() > ctx.maxFaces) { stop(ctx); return null; }
  }
  if (produced() > ctx.maxFaces) { stop(ctx); return null; }
  account(ctx, produced());
  return { roles, bufs, pass };
}

export function concat(parts) {
  const live = parts.filter((b) => b.nFaces > 0);
  if (live.length === 0) return parts[0] ?? new FaceBuffer(16);
  if (live.length === 1) return live[0];
  const faces = live.reduce((s, b) => s + b.nFaces, 0);
  const verts = live.reduce((s, b) => s + b.nVerts, 0);
  const out = new FaceBuffer(faces, verts);
  for (const b of live) out.append(b);
  return out;
}

export function partition(buf, pred, salt) {
  const cap = Math.min(buf.nFaces + 16, 1 << 16);
  const yes = new FaceBuffer(cap), no = new FaceBuffer(cap);
  for (let f = 0; f < buf.nFaces; f++) {
    const n = buf.read(f, V);
    rs = mix(salt, f);
    (pred(V, n, buf.tag[f]) ? yes : no).copyFace(buf, f);
  }
  return [yes, no];
}

function faceNormalZ(V, n) {
  Nrm[0] = Nrm[1] = Nrm[2] = 0;
  newell(V, 0, n, Nrm);
  return Nrm[2];
}

const compare = (cmp, value, measure) =>
  cmp === 'lt' ? (V, n) => measure(V, n) < value : (V, n) => measure(V, n) > value;

export function compileCond(c) {
  if (!c) return () => false;
  switch (c.type) {
    case 'facing':
      if (c.dir === 'up') return (V, n) => faceNormalZ(V, n) > UP;
      if (c.dir === 'down') return (V, n) => faceNormalZ(V, n) < -UP;
      return (V, n) => Math.abs(faceNormalZ(V, n)) <= UP;
    case 'chance':
      return () => rnd() * 100 < c.p;
    case 'tag': {
      const t = TAG_INDEX[c.tag];
      return (V, n, tag) => tag === t;
    }
    case 'size':
      return compare(c.cmp, c.value, (V, n) => Math.sqrt(newell(V, 0, n, Nrm) / 2));
    case 'z':
      return compare(c.cmp, c.value, (V, n) => { centroid(V, n, Ctr); return Ctr[2]; });
    case 'not': {
      const a = compileCond(c.a);
      return (V, n, t) => !a(V, n, t);
    }
    case 'and': {
      const a = compileCond(c.a), b = compileCond(c.b);
      return (V, n, t) => a(V, n, t) && b(V, n, t);
    }
    case 'or': {
      const a = compileCond(c.a), b = compileCond(c.b);
      return (V, n, t) => a(V, n, t) || b(V, n, t);
    }
  }
  return () => false;
}
