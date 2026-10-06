import { TAGS, TAG_COLORS } from './mesh.js';
import { newell } from './ops.js';

const RGB = TAG_COLORS.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

function triangleCount(buf) {
  let tris = 0;
  for (let f = 0; f < buf.nFaces; f++) tris += buf.count[f] - 2;
  return tris;
}

// Indexed render data: the face buffer's own corner positions (each face owns
// its corners, so flat shading is computed on the GPU and needs no normals),
// a fan-triangulation index, per-corner tag colours and optional edge indices
// that reuse the same positions.
export function toRenderBuffers(buf, withEdges) {
  const { start, count, tag } = buf;
  const nV = buf.nVerts;
  const tris = triangleCount(buf);
  const position = buf.pos.slice(0, nV * 3);
  const color = new Uint8Array(nV * 3);
  const index = new Uint32Array(tris * 3);
  const edges = withEdges ? new Uint32Array(nV * 2) : null;
  const tagCounts = new Array(TAGS.length).fill(0);
  let w = 0, e = 0;
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f], n = count[f];
    const [r, g, b] = RGB[tag[f]];
    tagCounts[tag[f]]++;
    for (let i = 0; i < n; i++) {
      const c = (s + i) * 3;
      color[c] = r; color[c + 1] = g; color[c + 2] = b;
    }
    for (let i = 1; i < n - 1; i++) {
      index[w++] = s; index[w++] = s + i; index[w++] = s + i + 1;
    }
    if (edges) {
      for (let i = 0; i < n; i++) { edges[e++] = s + i; edges[e++] = s + (i + 1 === n ? 0 : i + 1); }
    }
  }
  return { position, color, index, edges, tagCounts, tris };
}

// Contour lines: the mesh sliced by evenly spaced levels of a scalar field
// (x, y, z, or distance from the centre for 'radial'), as segment pairs.
// Spacing is automatic: about 120 lines across the object's diagonal, never
// finer than the mesh's own face size, scaled by `density`. That keeps the
// line density similar for every model and slicing direction.
export function toContours(buf, { axis = 'z', density = 1 } = {}) {
  const { pos, start, count: fc } = buf;
  const nV = buf.nVerts;
  const field = new Float32Array(nV);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < nV; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const k = { x: 0, y: 1, z: 2 }[axis];
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < nV; v++) {
    const f = k !== undefined ? pos[v * 3 + k] : Math.hypot(pos[v * 3] - cx, pos[v * 3 + 1] - cy, pos[v * 3 + 2] - cz);
    field[v] = f;
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  let area = 0;
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f] * 3;
    for (let i = 1; i < fc[f] - 1; i++) {
      const a = s, b = s + i * 3, c = s + (i + 1) * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
  }
  const faceSize = Math.sqrt(area / Math.max(1, buf.nFaces));
  const spacing = Math.max(diag / 120, faceSize * 1.2) / Math.max(0.05, density);
  const count = Math.min(4000, Math.max(1, Math.round((hi - lo) / spacing)));
  const h = (hi - lo) / count;
  if (!(h > 0)) return new Float32Array(0);

  let out = new Float32Array(1 << 16);
  let w = 0;
  const pt = [0, 0, 0, 0, 0, 0];
  const corners = [0, 0, 0];
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f], n = fc[f];
    for (let i = 1; i < n - 1; i++) {
      corners[0] = s; corners[1] = s + i; corners[2] = s + i + 1;
      const fa = field[corners[0]], fb = field[corners[1]], fcc = field[corners[2]];
      const tmin = Math.min(fa, fb, fcc), tmax = Math.max(fa, fb, fcc);
      // levels sit at lo + (j + 0.5) h, so no level ever touches the extremes
      const j0 = Math.max(0, Math.ceil((tmin - lo) / h - 0.5));
      const j1 = Math.min(count - 1, Math.floor((tmax - lo) / h - 0.5));
      for (let j = j0; j <= j1; j++) {
        const L = lo + (j + 0.5) * h;
        let found = 0;
        for (let e = 0; e < 3 && found < 2; e++) {
          const a = corners[e], b = corners[(e + 1) % 3];
          const va = field[a], vb = field[b];
          if ((va < L) === (vb < L)) continue;
          const t = (L - va) / (vb - va);
          for (let c = 0; c < 3; c++) pt[found * 3 + c] = pos[a * 3 + c] + (pos[b * 3 + c] - pos[a * 3 + c]) * t;
          found++;
        }
        if (found < 2) continue;
        if (w + 6 > out.length) { const grown = new Float32Array(out.length * 2); grown.set(out); out = grown; }
        for (let c = 0; c < 6; c++) out[w++] = pt[c];
      }
    }
  }
  return out.slice(0, w);
}

// Point cloud: `count` points spread over the surface by area (seeded), with
// their face's tag colour.
export function toPoints(buf, { count = 200_000, seed = 1 } = {}) {
  const { pos, start, count: fc, tag } = buf;
  const tris = triangleCount(buf);
  const area = new Float64Array(tris);
  let total = 0, t = 0;
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f] * 3;
    for (let i = 1; i < fc[f] - 1; i++, t++) {
      const a = s, b = s + i * 3, c = s + (i + 1) * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      area[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      total += area[t];
    }
  }
  let rs = seed | 0;
  const rnd = () => {
    rs = (rs + 0x6d2b79f5) | 0;
    let x = rs;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const position = new Float32Array(Math.ceil(count * 1.05 + 16) * 3);
  const color = new Uint8Array(position.length);
  let w = 0;
  t = 0;
  for (let f = 0; f < buf.nFaces && total > 0; f++) {
    const s = start[f] * 3;
    const [r, g, bl] = RGB[tag[f]];
    for (let i = 1; i < fc[f] - 1; i++, t++) {
      const expected = (area[t] / total) * count;
      let k = Math.floor(expected) + (rnd() < expected % 1 ? 1 : 0);
      const a = s, b = s + i * 3, c = s + (i + 1) * 3;
      while (k-- > 0 && w + 3 <= position.length) {
        const r1 = Math.sqrt(rnd()), r2 = rnd();
        const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
        for (let d = 0; d < 3; d++) position[w + d] = pos[a + d] * wa + pos[b + d] * wb + pos[c + d] * wc;
        color[w] = r; color[w + 1] = g; color[w + 2] = bl;
        w += 3;
      }
    }
  }
  return { position: position.slice(0, w), color: color.slice(0, w) };
}

// Polygon outlines as line-segment pairs.
export function toEdges(buf) {
  const out = new Float32Array(buf.nVerts * 6);
  const { pos, start, count } = buf;
  let e = 0;
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f] * 3, n = count[f];
    for (let i = 0; i < n; i++) {
      const a = s + i * 3, b = s + ((i + 1) % n) * 3;
      out[e++] = pos[a]; out[e++] = pos[a + 1]; out[e++] = pos[a + 2];
      out[e++] = pos[b]; out[e++] = pos[b + 1]; out[e++] = pos[b + 2];
    }
  }
  return out;
}

export function toSTL(buf) {
  const tris = triangleCount(buf);
  const data = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(data);
  const header = 'squishables binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  const { pos, start, count } = buf;
  const nrm = new Float64Array(3);
  let o = 84;
  for (let f = 0; f < buf.nFaces; f++) {
    const s = start[f] * 3, n = count[f];
    nrm[0] = nrm[1] = nrm[2] = 0;
    newell(pos, s, n, nrm);
    for (let i = 1; i < n - 1; i++) {
      for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, nrm[k], true);
      o += 12;
      for (const c of [0, i, i + 1]) {
        for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, pos[s + c * 3 + k], true);
        o += 12;
      }
      o += 2;
    }
  }
  return data;
}

// Keeps n-gons and groups faces by tag (become layers/groups in Rhino etc).
export function toOBJ(buf) {
  const lines = ['# squishables'];
  const { pos, start, count, tag } = buf;
  for (let v = 0; v < buf.nVerts; v++) {
    lines.push(`v ${pos[v * 3].toFixed(5)} ${pos[v * 3 + 1].toFixed(5)} ${pos[v * 3 + 2].toFixed(5)}`);
  }
  for (let t = 0; t < TAGS.length; t++) {
    let header = false;
    for (let f = 0; f < buf.nFaces; f++) {
      if (tag[f] !== t) continue;
      if (!header) { lines.push(`g ${TAGS[t]}`); header = true; }
      let line = 'f';
      for (let i = 0; i < count[f]; i++) line += ' ' + (start[f] + i + 1);
      lines.push(line);
    }
  }
  return lines.join('\n') + '\n';
}
