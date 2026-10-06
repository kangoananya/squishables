// Face operations. Each local op receives one face (V: flat xyz, n corners),
// its resolved params p, resolved output tags o, a seeded rnd(), and the output
// buffer. Returning false means "not applicable" and the face passes through.

import { num, int, bool, choice } from './params.js';
import { catmullClark } from './smooth.js';

const T = new Float64Array(256 * 3);
const Q = new Float64Array(256 * 3);
const C = new Float64Array(3);
const N = new Float64Array(3);

export function centroid(V, n, out) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) { x += V[i * 3]; y += V[i * 3 + 1]; z += V[i * 3 + 2]; }
  out[0] = x / n; out[1] = y / n; out[2] = z / n;
}

// Newell normal of the polygon starting at float index s. Writes the unit
// normal to out and returns the raw length (= 2 * area).
export function newell(V, s, n, out) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const a = s + i * 3, b = s + ((i + 1) % n) * 3;
    x += (V[a + 1] - V[b + 1]) * (V[a + 2] + V[b + 2]);
    y += (V[a + 2] - V[b + 2]) * (V[a] + V[b]);
    z += (V[a] - V[b]) * (V[a + 1] + V[b + 1]);
  }
  const len = Math.hypot(x, y, z);
  if (len > 0) { out[0] = x / len; out[1] = y / len; out[2] = z / len; }
  return len;
}

function copy3(dst, di, src, si) {
  dst[di * 3] = src[si * 3]; dst[di * 3 + 1] = src[si * 3 + 1]; dst[di * 3 + 2] = src[si * 3 + 2];
}

function lerp3(dst, di, src, a, b, t) {
  for (let k = 0; k < 3; k++) dst[di * 3 + k] = src[a * 3 + k] + (src[b * 3 + k] - src[a * 3 + k]) * t;
}

function bilinear(dst, di, V, u, v) {
  for (let k = 0; k < 3; k++) {
    const a = V[k] + (V[3 + k] - V[k]) * u;
    const b = V[9 + k] + (V[6 + k] - V[9 + k]) * u;
    dst[di * 3 + k] = a + (b - a) * v;
  }
}

function dist(V, a, b) {
  return Math.hypot(V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]);
}

function quadSplit(V, n, tag, out) {
  centroid(V, n, C);
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    copy3(Q, 0, V, i);
    lerp3(Q, 1, V, i, next, 0.5);
    Q[6] = C[0]; Q[7] = C[1]; Q[8] = C[2];
    lerp3(Q, 3, V, prev, i, 0.5);
    out.addFace(tag, Q, 4);
  }
  return true;
}

function scaledHeight(p, len, rnd) {
  return p.height * (p.relative ? Math.sqrt(len / 2) : 1) * (1 + p.jitter * (2 * rnd() - 1));
}

export const OPS = {
  extrude: {
    label: 'Extrude tapered',
    params: { height: num(0.3, -1, 2), taper: num(0.2, -1, 1), jitter: num(0, 0, 1), relative: bool(true) },
    outputs: { cap: 'cap', side: 'side' },
    apply(V, n, p, o, rnd, out) {
      const len = newell(V, 0, n, N);
      if (len < 1e-12) return false;
      centroid(V, n, C);
      const h = scaledHeight(p, len, rnd);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const v = V[i * 3 + k];
          T[i * 3 + k] = v + (C[k] - v) * p.taper + N[k] * h;
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        copy3(Q, 0, V, i); copy3(Q, 1, V, j); copy3(Q, 2, T, j); copy3(Q, 3, T, i);
        out.addFace(o.side, Q, 4);
      }
      out.addFace(o.cap, T, n);
      return true;
    },
  },

  point: {
    label: 'Extrude to point',
    params: { height: num(0.3, -1, 2), jitter: num(0, 0, 1), relative: bool(true) },
    outputs: { apex: 'apex' },
    apply(V, n, p, o, rnd, out) {
      const len = newell(V, 0, n, N);
      if (len < 1e-12) return false;
      centroid(V, n, C);
      const h = scaledHeight(p, len, rnd);
      Q[6] = C[0] + N[0] * h; Q[7] = C[1] + N[1] * h; Q[8] = C[2] + N[2] * h;
      for (let i = 0; i < n; i++) {
        copy3(Q, 0, V, i); copy3(Q, 1, V, (i + 1) % n);
        out.addFace(o.apex, Q, 3);
      }
      return true;
    },
  },

  grid: {
    label: 'Split grid',
    params: { u: int(2, 1, 12), v: int(2, 1, 12) },
    outputs: { out: 'keep' },
    apply(V, n, p, o, rnd, out) {
      if (n === 4) {
        const nu = p.u, nv = p.v;
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            bilinear(Q, 0, V, i / nu, j / nv);
            bilinear(Q, 1, V, (i + 1) / nu, j / nv);
            bilinear(Q, 2, V, (i + 1) / nu, (j + 1) / nv);
            bilinear(Q, 3, V, i / nu, (j + 1) / nv);
            out.addFace(o.out, Q, 4);
          }
        }
        return true;
      }
      if (n === 3) {
        // midpoint subdivision: corners 0..2, midpoints at 3 (01), 4 (12), 5 (20)
        copy3(T, 0, V, 0); copy3(T, 1, V, 1); copy3(T, 2, V, 2);
        lerp3(T, 3, V, 0, 1, 0.5); lerp3(T, 4, V, 1, 2, 0.5); lerp3(T, 5, V, 2, 0, 0.5);
        for (const [a, b, c] of [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]]) {
          copy3(Q, 0, T, a); copy3(Q, 1, T, b); copy3(Q, 2, T, c);
          out.addFace(o.out, Q, 3);
        }
        return true;
      }
      return quadSplit(V, n, o.out, out);
    },
  },

  split: {
    label: 'Split in two',
    params: { ratio: num(0.5, 0.05, 0.95), jitter: num(0, 0, 0.45), dir: choice('longest', ['longest', 'shortest', 'u', 'v', 'random']) },
    outputs: { a: 'keep', b: 'keep' },
    apply(V, n, p, o, rnd, out) {
      if (n !== 4) return false;
      const r = Math.min(0.99, Math.max(0.01, p.ratio + p.jitter * (2 * rnd() - 1)));
      let alongU;
      if (p.dir === 'u') alongU = true;
      else if (p.dir === 'v') alongU = false;
      else if (p.dir === 'random') alongU = rnd() < 0.5;
      else {
        const lu = dist(V, 0, 1) + dist(V, 3, 2), lv = dist(V, 0, 3) + dist(V, 1, 2);
        alongU = p.dir === 'longest' ? lu >= lv : lu < lv;
      }
      if (alongU) {
        lerp3(T, 0, V, 0, 1, r); lerp3(T, 1, V, 3, 2, r);
        copy3(Q, 0, V, 0); copy3(Q, 1, T, 0); copy3(Q, 2, T, 1); copy3(Q, 3, V, 3);
        out.addFace(o.a, Q, 4);
        copy3(Q, 0, T, 0); copy3(Q, 1, V, 1); copy3(Q, 2, V, 2); copy3(Q, 3, T, 1);
        out.addFace(o.b, Q, 4);
      } else {
        lerp3(T, 0, V, 1, 2, r); lerp3(T, 1, V, 0, 3, r);
        copy3(Q, 0, V, 0); copy3(Q, 1, V, 1); copy3(Q, 2, T, 0); copy3(Q, 3, T, 1);
        out.addFace(o.a, Q, 4);
        copy3(Q, 0, T, 1); copy3(Q, 1, T, 0); copy3(Q, 2, V, 2); copy3(Q, 3, V, 3);
        out.addFace(o.b, Q, 4);
      }
      return true;
    },
  },

  frame: {
    label: 'Split frame',
    params: { amount: num(0.3, 0.01, 0.95), mode: choice('offset', ['offset', 'scale']) },
    outputs: { frame: 'frame', inner: 'inner' },
    apply(V, n, p, o, rnd, out) {
      const len = newell(V, 0, n, N);
      if (len < 1e-12) return false;
      centroid(V, n, C);
      const d = p.amount * 0.5 * Math.sqrt(len / 2);
      for (let i = 0; i < n; i++) {
        if (p.mode !== 'scale' && offsetCorner(V, n, i, d)) continue;
        for (let k = 0; k < 3; k++) T[i * 3 + k] = V[i * 3 + k] + (C[k] - V[i * 3 + k]) * p.amount;
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        copy3(Q, 0, V, i); copy3(Q, 1, V, j); copy3(Q, 2, T, j); copy3(Q, 3, T, i);
        out.addFace(o.frame, Q, 4);
      }
      out.addFace(o.inner, T, n);
      return true;
    },
  },

  quads: {
    label: 'Split to quads',
    params: {},
    outputs: { out: 'keep' },
    apply(V, n, p, o, rnd, out) {
      return quadSplit(V, n, o.out, out);
    },
  },

  remove: {
    label: 'Remove',
    params: {},
    outputs: {},
    apply() {
      return true;
    },
  },

  smooth: {
    label: 'Smooth',
    global: true,
    params: {},
    outputs: {},
    applyAll: (buf, p, maxFaces) => catmullClark(buf, maxFaces),
  },

  // Catmull–Clark with exposed weights, after Hansmeyer's subdivision studies:
  // 1/1/0 is standard smoothing; other values fold and layer the surface.
  subdivide: {
    label: 'Subdivide (weighted)',
    global: true,
    params: {
      vertex: num(1, -10, 10), edge: num(1, -10, 10), face: num(0, -5, 5),
      ridge: num(0, -3, 3), variation: num(0, 0, 10), frequency: num(2, 0.1, 50, 0.1),
    },
    outputs: {},
    applyAll: (buf, p, maxFaces, salt) => catmullClark(buf, maxFaces, p, salt),
  },
};

// Miter-offset corner i inward by distance d (in the face plane, normal N).
// Writes T[i]; returns false when the corner is degenerate.
function offsetCorner(V, n, i, d) {
  const a = ((i - 1 + n) % n) * 3, b = i * 3, c = ((i + 1) % n) * 3;
  let e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
  let e2x = V[c] - V[b], e2y = V[c + 1] - V[b + 1], e2z = V[c + 2] - V[b + 2];
  const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
  if (l1 < 1e-12 || l2 < 1e-12) return false;
  e1x /= l1; e1y /= l1; e1z /= l1; e2x /= l2; e2y /= l2; e2z /= l2;
  // inward edge normals: N x e
  const n1x = N[1] * e1z - N[2] * e1y, n1y = N[2] * e1x - N[0] * e1z, n1z = N[0] * e1y - N[1] * e1x;
  const n2x = N[1] * e2z - N[2] * e2y, n2y = N[2] * e2x - N[0] * e2z, n2z = N[0] * e2y - N[1] * e2x;
  const denom = 1 + n1x * n2x + n1y * n2y + n1z * n2z;
  if (denom < 0.1) return false;
  const s = d / denom;
  T[b] = V[b] + (n1x + n2x) * s;
  T[b + 1] = V[b + 1] + (n1y + n2y) * s;
  T[b + 2] = V[b + 2] + (n1z + n2z) * s;
  return true;
}
