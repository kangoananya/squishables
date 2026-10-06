// Catmull–Clark on a face-vertex soup.
//
// 1. weld:    corners are merged by quantised position into shared vertices
//             (skipped when the input came from a previous subdivision, which
//             hands over its topology in buf.vid).
// 2. conform: face-local ops (split, grid, frame…) leave T-junctions — a vertex
//             sitting on a neighbour's edge without being part of it. Those
//             vertices are inserted into the neighbour's edge, so the mesh is
//             crack-free and smoothing flows across it instead of stopping.
// 3. subdivide: standard Catmull–Clark; edges that still don't have exactly
//             two faces (real borders, fins) are kept as sharp creases.
//
// Each level also emits its edge table (buf.edges), so a following
// subdivision skips edge hashing too: old edge e splits into half-edges 2e
// (at its A end) and 2e+1 (B end), and every old corner c adds the edge
// 2·nE + c from its edge point to the face point. kernel-rs numbers edges the
// same way, so both implementations stay bit-identical.
//
// Weights (Hansmeyer-style): `vertex` and `edge` blend from the unsmoothed
// position (0) to the Catmull–Clark position (1) and may overshoot; `face`
// pushes each new face point along its normal and `ridge` each edge point
// along its faces' normals, both relative to size. `variation` modulates the
// face and vertex weights with smooth 3D noise (`frequency`, seeded by
// `salt`), so ornament changes across the surface instead of repeating.

import { FaceBuffer, FaceLimit } from './mesh.js';
import { newell } from './ops.js';
import { useWasm, wasmCatmullClark } from './wasm.js';

export function catmullClark(src, maxFaces, { vertex = 1, edge = 1, face = 0, ridge = 0, variation = 0, frequency = 2 } = {}, salt = 0) {
  if (src.nVerts > maxFaces) throw new FaceLimit();
  if (useWasm()) return wasmCatmullClark(src, maxFaces, { vertex, edge, face, ridge, variation, frequency }, salt);
  const welded = weld(src);
  let mesh = { nF: src.nFaces, fStart: src.start, fCount: src.count, cv: welded.vid };
  let edges = src.vid && src.nUnique && src.edges ? handedOver(src.edges) : buildEdges(mesh, src.nVerts);
  if (edges.open > 0) {
    const conformed = conform(mesh, edges, welded);
    if (conformed) {
      mesh = conformed;
      edges = buildEdges(mesh, mesh.cv.length);
    }
  }
  return subdivide(src.tag, welded, mesh, edges, { vertex, edge, face, ridge, variation, frequency, salt });
}

class EdgeTable {
  constructor(n) {
    let cap = 1;
    while (cap < n * 2) cap <<= 1;
    this.mask = cap - 1;
    this.table = new Int32Array(cap).fill(-1);
    this.A = new Uint32Array(n);
    this.B = new Uint32Array(n);
    this.n = 0;
  }

  id(a, b) {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) & this.mask;
    for (;;) {
      const e = this.table[h];
      if (e < 0) {
        const id = this.n++;
        this.table[h] = id;
        this.A[id] = lo;
        this.B[id] = hi;
        return id;
      }
      if (this.A[e] === lo && this.B[e] === hi) return e;
      h = (h + 1) & this.mask;
    }
  }
}

function weld(src) {
  const nC = src.nVerts;
  const pos = src.pos;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let c = 0; c < nC; c++) {
    const x = pos[c * 3], y = pos[c * 3 + 1], z = pos[c * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;

  if (src.vid && src.nUnique) {
    const nV = src.nUnique, vid = src.vid;
    const P = new Float64Array(nV * 3);
    for (let c = 0; c < nC; c++) {
      const v = vid[c] * 3;
      P[v] = pos[c * 3]; P[v + 1] = pos[c * 3 + 1]; P[v + 2] = pos[c * 3 + 2];
    }
    return { P, nV, vid, diag };
  }

  const q = diag * 1e-6;
  let cap = 1;
  while (cap < nC * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const QX = new Int32Array(nC), QY = new Int32Array(nC), QZ = new Int32Array(nC);
  const P = new Float64Array(nC * 3);
  const vid = new Uint32Array(nC);
  let nV = 0;
  for (let c = 0; c < nC; c++) {
    const x = pos[c * 3], y = pos[c * 3 + 1], z = pos[c * 3 + 2];
    const qx = Math.round((x - x0) / q), qy = Math.round((y - y0) / q), qz = Math.round((z - z0) / q);
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) {
        table[h] = nV;
        QX[nV] = qx; QY[nV] = qy; QZ[nV] = qz;
        P[nV * 3] = x; P[nV * 3 + 1] = y; P[nV * 3 + 2] = z;
        vid[c] = nV++;
        break;
      }
      if (QX[e] === qx && QY[e] === qy && QZ[e] === qz) { vid[c] = e; break; }
      h = (h + 1) & mask;
    }
  }
  return { P, nV, vid, diag };
}

function buildEdges({ nF, fStart, fCount, cv }, nC) {
  const et = new EdgeTable(nC);
  const cornerEdge = new Uint32Array(nC);
  const EF = new Uint16Array(nC);
  for (let f = 0; f < nF; f++) {
    const s = fStart[f], n = fCount[f];
    for (let i = 0; i < n; i++) {
      const e = et.id(cv[s + i], cv[s + (i + 1 === n ? 0 : i + 1)]);
      cornerEdge[s + i] = e;
      if (EF[e] < 65535) EF[e]++;
    }
  }
  let open = 0;
  for (let e = 0; e < et.n; e++) if (EF[e] === 1) open++;
  return { A: et.A, B: et.B, cornerEdge, EF, nE: et.n, open };
}

function handedOver({ cornerEdge, a, b, ef }) {
  let open = 0;
  for (let e = 0; e < ef.length; e++) if (ef[e] === 1) open++;
  return { A: a, B: b, cornerEdge, EF: ef, nE: a.length, open };
}

// Inserts hanging vertices into the open edges they lie on. Returns the new
// face list, or null when nothing needed fixing.
function conform({ nF, fStart, fCount, cv }, { A, B, cornerEdge, EF, nE }, { P, diag }) {
  // candidate hanging vertices: endpoints of open edges, bucketed in a grid
  let openLen = 0, openCount = 0;
  const isCandidate = new Uint8Array(P.length / 3);
  for (let e = 0; e < nE; e++) {
    if (EF[e] !== 1) continue;
    const a = A[e], b = B[e];
    isCandidate[a] = isCandidate[b] = 1;
    openLen += dist(P, a, b);
    openCount++;
  }
  const cell = Math.max(openLen / openCount, diag * 1e-4);
  const grid = new Map();
  for (let v = 0; v < isCandidate.length; v++) {
    if (!isCandidate[v]) continue;
    const k = cellKey(Math.floor(P[v * 3] / cell), Math.floor(P[v * 3 + 1] / cell), Math.floor(P[v * 3 + 2] / cell));
    const list = grid.get(k);
    if (list) list.push(v); else grid.set(k, [v]);
  }

  const outStart = new Uint32Array(nF);
  const outCount = new Uint32Array(nF);
  const out = [];
  const hits = [];
  let inserted = 0;
  for (let f = 0; f < nF; f++) {
    const s = fStart[f], n = fCount[f];
    outStart[f] = out.length;
    for (let i = 0; i < n; i++) {
      const a = cv[s + i];
      out.push(a);
      if (EF[cornerEdge[s + i]] !== 1) continue;
      const b = cv[s + (i + 1 === n ? 0 : i + 1)];
      hits.length = 0;
      collectOnSegment(P, a, b, grid, cell, hits);
      if (hits.length > 1) hits.sort((p, q) => p[0] - q[0]);
      for (const [, v] of hits) if (out[out.length - 1] !== v) { out.push(v); inserted++; }
    }
    outCount[f] = out.length - outStart[f];
  }
  return inserted ? { nF, fStart: outStart, fCount: outCount, cv: Uint32Array.from(out) } : null;
}

// numeric cell hash; collisions only merge buckets (distances are re-checked)
const cellKey = (ix, iy, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;

function collectOnSegment(P, a, b, grid, cell, hits) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 === 0) return;
  const tol2 = len2 * 1e-8;
  const lx = Math.floor(Math.min(ax, ax + dx) / cell), hx = Math.floor(Math.max(ax, ax + dx) / cell);
  const ly = Math.floor(Math.min(ay, ay + dy) / cell), hy = Math.floor(Math.max(ay, ay + dy) / cell);
  const lz = Math.floor(Math.min(az, az + dz) / cell), hz = Math.floor(Math.max(az, az + dz) / cell);
  if ((hx - lx + 1) * (hy - ly + 1) * (hz - lz + 1) > 4096) return;
  for (let ix = lx; ix <= hx; ix++) {
    for (let iy = ly; iy <= hy; iy++) {
      for (let iz = lz; iz <= hz; iz++) {
        const list = grid.get(cellKey(ix, iy, iz));
        if (!list) continue;
        for (const v of list) {
          if (v === a || v === b) continue;
          const vx = P[v * 3] - ax, vy = P[v * 3 + 1] - ay, vz = P[v * 3 + 2] - az;
          const t = (vx * dx + vy * dy + vz * dz) / len2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const ex = vx - t * dx, ey = vy - t * dy, ez = vz - t * dz;
          if (ex * ex + ey * ey + ez * ez < tol2 && !hits.some((h) => h[1] === v)) hits.push([t, v]);
        }
      }
    }
  }
}

function dist(P, a, b) {
  return Math.hypot(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
}

function subdivide(tags, { P, nV }, { nF, fStart, fCount, cv }, { A, B, cornerEdge, EF, nE }, w) {
  const { vertex, edge, face, ridge, variation, frequency } = w;
  const noise = variation !== 0 ? makeNoise(w.salt) : null;
  const displace = face !== 0 || variation !== 0;
  // --- face points (+ optional displacement along the face normal)
  let nC = 0, maxN = 3;
  for (let f = 0; f < nF; f++) { nC += fCount[f]; if (fCount[f] > maxN) maxN = fCount[f]; }
  const FP = new Float64Array(nF * 3);
  const FPout = displace ? new Float64Array(nF * 3) : FP;
  const FN = ridge !== 0 ? new Float64Array(nF * 3) : null;
  const tmp = new Float64Array(maxN * 3);
  const nrm = new Float64Array(3);
  for (let f = 0; f < nF; f++) {
    const s = fStart[f], n = fCount[f];
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const v = cv[s + i] * 3;
      x += P[v]; y += P[v + 1]; z += P[v + 2];
    }
    FP[f * 3] = x / n; FP[f * 3 + 1] = y / n; FP[f * 3 + 2] = z / n;
    if (displace || FN) {
      for (let i = 0; i < n; i++) {
        const v = cv[s + i] * 3;
        tmp[i * 3] = P[v]; tmp[i * 3 + 1] = P[v + 1]; tmp[i * 3 + 2] = P[v + 2];
      }
      nrm[0] = nrm[1] = nrm[2] = 0;
      const size = Math.sqrt(newell(tmp, 0, n, nrm) / 2);
      if (FN) { FN[f * 3] = nrm[0]; FN[f * 3 + 1] = nrm[1]; FN[f * 3 + 2] = nrm[2]; }
      if (displace) {
        const k = noise ? face + variation * noise(FP[f * 3] * frequency, FP[f * 3 + 1] * frequency, FP[f * 3 + 2] * frequency) : face;
        const d = size * k;
        FPout[f * 3] = FP[f * 3] + nrm[0] * d;
        FPout[f * 3 + 1] = FP[f * 3 + 1] + nrm[1] * d;
        FPout[f * 3 + 2] = FP[f * 3 + 2] + nrm[2] * d;
      }
    }
  }

  // --- per-edge face-point sums, per-vertex face-point sums
  const ES = new Float64Array(nE * 3);
  const EN = FN ? new Float64Array(nE * 3) : null;
  const VF = new Float64Array(nV * 3), VFn = new Uint32Array(nV);
  for (let f = 0; f < nF; f++) {
    const s = fStart[f], n = fCount[f];
    const fx = FP[f * 3], fy = FP[f * 3 + 1], fz = FP[f * 3 + 2];
    for (let i = 0; i < n; i++) {
      const e = cornerEdge[s + i] * 3;
      ES[e] += fx; ES[e + 1] += fy; ES[e + 2] += fz;
      if (EN) { EN[e] += FN[f * 3]; EN[e + 1] += FN[f * 3 + 1]; EN[e + 2] += FN[f * 3 + 2]; }
      const v = cv[s + i];
      VF[v * 3] += fx; VF[v * 3 + 1] += fy; VF[v * 3 + 2] += fz;
      VFn[v]++;
    }
  }

  // --- edge points + edge-midpoint / crease accumulators per vertex
  const EP = new Float64Array(nE * 3);
  const VR = new Float64Array(nV * 3), VRn = new Uint32Array(nV);
  const VC = new Float64Array(nV * 3), VCn = new Uint32Array(nV);
  for (let e = 0; e < nE; e++) {
    const a = A[e] * 3, b = B[e] * 3;
    const crease = EF[e] !== 2;
    for (let k = 0; k < 3; k++) {
      const mid = (P[a + k] + P[b + k]) / 2;
      EP[e * 3 + k] = crease ? mid : mid + ((P[a + k] + P[b + k] + ES[e * 3 + k]) / 4 - mid) * edge;
      VR[a + k] += mid; VR[b + k] += mid;
      if (crease) { VC[a + k] += P[b + k]; VC[b + k] += P[a + k]; }
    }
    if (EN) {
      // ridge: lift the edge point along its faces' average normal
      const nx = EN[e * 3], ny = EN[e * 3 + 1], nz = EN[e * 3 + 2];
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-12) {
        const d = (ridge * dist(P, A[e], B[e])) / nl;
        EP[e * 3] += nx * d; EP[e * 3 + 1] += ny * d; EP[e * 3 + 2] += nz * d;
      }
    }
    VRn[A[e]]++; VRn[B[e]]++;
    if (crease) { VCn[A[e]]++; VCn[B[e]]++; }
  }

  // --- new vertex points
  const NP = new Float64Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    const cn = VCn[v], val = VRn[v];
    const wv = noise ? vertex + variation * noise(P[v * 3] * frequency + 17.3, P[v * 3 + 1] * frequency - 5.1, P[v * 3 + 2] * frequency + 9.7) : vertex;
    for (let k = 0; k < 3; k++) {
      const i = v * 3 + k, p = P[i];
      if (cn === 2) NP[i] = (6 * p + VC[i]) / 8;
      else if (cn > 0 || !val) NP[i] = p;
      else NP[i] = p + ((VF[i] / VFn[v] + (2 * VR[i]) / val + (val - 3) * p) / val - p) * wv;
    }
  }

  // --- quads (vertex, next edge, face, previous edge), written straight into
  // the output arrays together with their topology for the next level
  const out = new FaceBuffer(nC, nC * 4);
  const { pos, start, count, tag } = out;
  const vid = new Uint32Array(nC * 4);
  const eBase = nV, fBase = nV + nE;
  // next level's edges: half-edges first, then one face edge per old corner
  const nE2 = 2 * nE + nC, fe = 2 * nE;
  const ce2 = new Uint32Array(nC * 4);
  const a2 = new Uint32Array(nE2), b2 = new Uint32Array(nE2), ef2 = new Uint16Array(nE2);
  for (let e = 0; e < nE; e++) {
    a2[2 * e] = A[e]; b2[2 * e] = eBase + e; ef2[2 * e] = EF[e];
    a2[2 * e + 1] = B[e]; b2[2 * e + 1] = eBase + e; ef2[2 * e + 1] = EF[e];
  }
  let q = 0;
  for (let f = 0; f < nF; f++) {
    const s = fStart[f], n = fCount[f], t = tags[f];
    for (let i = 0; i < n; i++, q++) {
      const c = s + i, cp = s + (i === 0 ? n - 1 : i - 1);
      const v = cv[c], e1 = cornerEdge[c], e0 = cornerEdge[cp];
      const o = q * 4;
      start[q] = o;
      count[q] = 4;
      tag[q] = t;
      let w = o * 3;
      pos[w] = NP[v * 3]; pos[w + 1] = NP[v * 3 + 1]; pos[w + 2] = NP[v * 3 + 2];
      pos[w + 3] = EP[e1 * 3]; pos[w + 4] = EP[e1 * 3 + 1]; pos[w + 5] = EP[e1 * 3 + 2];
      pos[w + 6] = FPout[f * 3]; pos[w + 7] = FPout[f * 3 + 1]; pos[w + 8] = FPout[f * 3 + 2];
      pos[w + 9] = EP[e0 * 3]; pos[w + 10] = EP[e0 * 3 + 1]; pos[w + 11] = EP[e0 * 3 + 2];
      vid[o] = v;
      vid[o + 1] = eBase + e1;
      vid[o + 2] = fBase + f;
      vid[o + 3] = eBase + e0;
      // the quad's edges: half of e1, face edge of c, face edge of cp, half of e0
      ce2[o] = 2 * e1 + (A[e1] !== v ? 1 : 0);
      ce2[o + 1] = fe + c;
      ce2[o + 2] = fe + cp;
      ce2[o + 3] = 2 * e0 + (A[e0] !== v ? 1 : 0);
      a2[fe + c] = eBase + e1; b2[fe + c] = fBase + f; ef2[fe + c] = 2;
    }
  }
  out.nFaces = nC;
  out.nVerts = nC * 4;
  out.vid = vid;
  out.nUnique = nV + nE + nF;
  out.edges = { cornerEdge: ce2, a: a2, b: b2, ef: ef2 };
  return out;
}

// Smooth seeded 3D value noise in [-1, 1].
function makeNoise(seed) {
  const lattice = (x, y, z) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1;
  };
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
    return lerp(
      lerp(lerp(lattice(xi, yi, zi), lattice(xi + 1, yi, zi), u), lerp(lattice(xi, yi + 1, zi), lattice(xi + 1, yi + 1, zi), u), v),
      lerp(lerp(lattice(xi, yi, zi + 1), lattice(xi + 1, yi, zi + 1), u), lerp(lattice(xi, yi + 1, zi + 1), lattice(xi + 1, yi + 1, zi + 1), u), v),
      w,
    );
  };
}
