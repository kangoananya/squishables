import { FaceBuffer, TAG_INDEX } from './mesh.js';
import { num, int, choice, resolveParams } from './params.js';

export const PRIMITIVES = {
  box: {
    label: 'Box',
    params: { width: num(1, 0.1, 5), depth: num(1, 0.1, 5), height: num(1, 0.1, 5) },
  },
  prism: {
    label: 'Prism',
    params: { sides: int(6, 3, 32), radius: num(0.6, 0.1, 3), height: num(1, 0.1, 5) },
  },
  plane: {
    label: 'Plane',
    params: { width: num(2, 0.1, 10), depth: num(2, 0.1, 10) },
  },
  platonic: {
    label: 'Platonic solid',
    params: {
      solid: choice('cube', [
        'tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron',
        'cuboctahedron', 'rhombic dodecahedron', 'truncated octahedron', 'icosidodecahedron',
      ]),
      radius: num(1, 0.1, 5),
    },
  },
};

const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSA_V = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI],
  [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICOSA_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];
const SOLIDS = {
  tetrahedron: { v: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], f: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]] },
  cube: {
    v: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    f: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  },
  octahedron: {
    v: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    f: [[4, 0, 2], [4, 2, 1], [4, 1, 3], [4, 3, 0], [5, 2, 0], [5, 1, 2], [5, 3, 1], [5, 0, 3]],
  },
  icosahedron: { v: ICOSA_V, f: ICOSA_F },
  dodecahedron: dual(ICOSA_V, ICOSA_F),
  // Archimedean / Catalan solids from their vertex sets
  cuboctahedron: fromPoints(signedPerms([1, 1, 0], true)),
  'rhombic dodecahedron': fromPoints([...signedPerms([1, 1, 1], true), ...signedPerms([2, 0, 0], true)]),
  'truncated octahedron': fromPoints(signedPerms([0, 1, 2], true)),
  icosidodecahedron: fromPoints([...signedPerms([0, 0, PHI], false), ...signedPerms([0.5, PHI / 2, (PHI * PHI) / 2], false)]),
};

// Dual polyhedron: one vertex per face centroid, one face per original vertex
// (its surrounding face centroids sorted by angle around the vertex axis).
function dual(verts, faces) {
  const v = faces.map((f) => [0, 1, 2].map((k) => f.reduce((s, i) => s + verts[i][k], 0) / f.length));
  const f = verts.map((axis, vi) => {
    const ring = faces.map((face, fi) => (face.includes(vi) ? fi : -1)).filter((fi) => fi >= 0);
    const [ux, uy, uz] = perpendicular(axis);
    const [wx, wy, wz] = cross(axis, [ux, uy, uz]);
    const angle = (fi) => Math.atan2(dot(v[fi], [wx, wy, wz]), dot(v[fi], [ux, uy, uz]));
    return ring.sort((a, b) => angle(a) - angle(b));
  });
  return { v, f };
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function perpendicular(a) { return cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); }

// All sign combinations of a coordinate triple, over all permutations (or
// only the cyclic ones), without duplicates.
function signedPerms(xyz, allPerms) {
  const orders = allPerms
    ? [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    : [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  const out = new Map();
  for (const o of orders) {
    for (let signs = 0; signs < 8; signs++) {
      const p = o.map((i, k) => xyz[i] * (signs & (1 << k) ? -1 : 1));
      out.set(p.map((c) => c.toFixed(6)).join(','), p);
    }
  }
  return [...out.values()];
}

// Convex hull of a small point set (brute force over point triples): each
// supporting plane becomes one polygon, its points ordered around its centre.
function fromPoints(v) {
  const f = [];
  const seen = new Set();
  const eps = 1e-6;
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      for (let k = j + 1; k < v.length; k++) {
        const ab = [0, 1, 2].map((c) => v[j][c] - v[i][c]);
        const ac = [0, 1, 2].map((c) => v[k][c] - v[i][c]);
        let n = cross(ab, ac);
        const len = Math.hypot(...n);
        if (len < eps) continue;
        n = n.map((c) => c / len);
        let d = dot(n, v[i]);
        let above = 0, below = 0;
        for (const p of v) {
          const sd = dot(n, p) - d;
          if (sd > eps) above++;
          else if (sd < -eps) below++;
        }
        if (above && below) continue;
        if (above) { n = n.map((c) => -c); d = -d; }
        const key = n.map((c) => Math.round(c * 1e4) + 0).join(','); // +0 folds -0 into 0
        if (seen.has(key)) continue;
        seen.add(key);
        const ring = v.map((p, idx) => idx).filter((idx) => Math.abs(dot(n, v[idx]) - d) < eps);
        const c = [0, 1, 2].map((a) => ring.reduce((sum, idx) => sum + v[idx][a], 0) / ring.length);
        const u = perpendicular(n);
        const w = cross(n, u);
        const angle = (idx) => {
          const r = [0, 1, 2].map((a) => v[idx][a] - c[a]);
          return Math.atan2(dot(r, w), dot(r, u));
        };
        f.push(ring.sort((a, b) => angle(a) - angle(b)));
      }
    }
  }
  return { v, f };
}

function addSolid(buf, { v, f }, radius, tag) {
  const r = Math.max(...v.map((p) => Math.hypot(...p)));
  for (const face of f) {
    const pts = face.map((i) => v[i].map((c) => (c / r) * radius));
    const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0));
    const n = cross(pts[1].map((x, k) => x - pts[0][k]), pts[2].map((x, k) => x - pts[0][k]));
    if (dot(n, c) < 0) pts.reverse(); // make every face point outward
    buf.addFace(tag, pts.flat(), pts.length);
  }
}

export function buildPrimitive(prim = {}) {
  const def = PRIMITIVES[prim.type] ?? PRIMITIVES.box;
  const p = resolveParams(def.params, prim.params);
  const buf = new FaceBuffer(64);
  const tag = TAG_INDEX.base;
  if (def === PRIMITIVES.platonic) {
    addSolid(buf, SOLIDS[p.solid] ?? SOLIDS.cube, p.radius, tag);
  } else if (def === PRIMITIVES.plane) {
    const w = p.width / 2, d = p.depth / 2;
    buf.addFace(tag, [-w, -d, 0, w, -d, 0, w, d, 0, -w, d, 0], 4);
  } else if (def === PRIMITIVES.prism) {
    const n = Math.round(p.sides);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + Math.PI / n + (2 * Math.PI * i) / n;
      pts.push([Math.cos(a) * p.radius, Math.sin(a) * p.radius]);
    }
    extrudeOutline(buf, pts, p.height, tag);
  } else {
    const w = p.width / 2, d = p.depth / 2;
    extrudeOutline(buf, [[-w, -d], [w, -d], [w, d], [-w, d]], p.height, tag);
  }
  return buf;
}

// Closed solid from a counter-clockwise 2D outline, z from 0 to h.
function extrudeOutline(buf, pts, h, tag) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    buf.addFace(tag, [ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, h], 4);
  }
  buf.addFace(tag, pts.flatMap(([x, y]) => [x, y, h]), n);
  buf.addFace(tag, pts.slice().reverse().flatMap(([x, y]) => [x, y, 0]), n);
}
