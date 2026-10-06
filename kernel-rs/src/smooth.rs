//! Weighted Catmull–Clark on a face soup — the Rust twin of
//! `src/kernel/smooth.js` (weld → conform T-junctions → subdivide).
//!
//! Each level also emits its own topology (welded vertex id per corner and the
//! edge table), so a following subdivision skips welding and edge hashing:
//! old edge e splits into half-edges 2e (at its A end) and 2e+1 (B end), and
//! every old corner c adds the edge 2·nE + c from its edge point to the face
//! point. Both implementations number edges this way and stay bit-identical.

use crate::Mesh;
use std::collections::HashMap;

pub struct Input<'a> {
    pub pos: &'a [f32],
    pub start: &'a [u32],
    pub count: &'a [u8],
    pub tag: &'a [u8],
    pub vid: Option<(&'a [u32], usize)>,
    pub edges: Option<EdgesIn<'a>>,
}

/// Edge table handed over from a previous level.
pub struct EdgesIn<'a> {
    pub corner_edge: &'a [u32],
    pub a: &'a [u32],
    pub b: &'a [u32],
    pub ef: &'a [u16],
}

pub struct Weights {
    pub vertex: f64,
    pub edge: f64,
    pub face: f64,
    pub ridge: f64,
    pub variation: f64,
    pub frequency: f64,
    pub salt: i32,
}

struct Welded {
    p: Vec<f64>,
    nv: usize,
    vid: Vec<u32>,
    diag: f64,
}

struct Faces {
    start: Vec<u32>,
    count: Vec<u32>,
    cv: Vec<u32>,
}

struct Edges {
    a: Vec<u32>,
    b: Vec<u32>,
    corner_edge: Vec<u32>,
    ef: Vec<u16>,
    open: usize,
}

pub fn catmull_clark(src: &Input, w: &Weights) -> Mesh {
    let welded = weld(src);
    let mut faces = Faces {
        start: src.start.to_vec(),
        count: src.count.iter().map(|&c| c as u32).collect(),
        cv: welded.vid.clone(),
    };
    let mut edges = match (&src.edges, src.vid) {
        (Some(e), Some(_)) => Edges {
            a: e.a.to_vec(),
            b: e.b.to_vec(),
            corner_edge: e.corner_edge.to_vec(),
            ef: e.ef.to_vec(),
            open: e.ef.iter().filter(|&&c| c == 1).count(),
        },
        _ => build_edges(&faces),
    };
    if edges.open > 0 {
        if let Some(conformed) = conform(&faces, &edges, &welded) {
            faces = conformed;
            edges = build_edges(&faces);
        }
    }
    subdivide(src.tag, &welded, &faces, &edges, w)
}

/// A vector whose every element will be written before it is read.
fn uninit<T: Copy>(n: usize) -> Vec<T> {
    let mut v = Vec::with_capacity(n);
    // SAFETY: T is Copy (no drop), and callers write all n elements before reading
    unsafe { v.set_len(n) };
    v
}

// ---------------------------------------------------------------- hashing

struct EdgeTable {
    mask: u32,
    table: Vec<i32>,
    a: Vec<u32>,
    b: Vec<u32>,
    n: u32,
}

impl EdgeTable {
    fn new(n: usize) -> Self {
        let mut cap = 1usize;
        while cap < n * 2 {
            cap <<= 1;
        }
        EdgeTable { mask: (cap - 1) as u32, table: vec![-1; cap], a: uninit(n), b: uninit(n), n: 0 }
    }

    #[inline]
    fn id(&mut self, a: u32, b: u32) -> u32 {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let mut h = (lo.wrapping_mul(0x9e3779b1) ^ hi.wrapping_mul(0x85ebca6b)) & self.mask;
        loop {
            // SAFETY: h is masked to the table size; stored ids are < n
            let e = unsafe { *self.table.get_unchecked(h as usize) };
            if e < 0 {
                let id = self.n;
                self.n += 1;
                unsafe {
                    *self.table.get_unchecked_mut(h as usize) = id as i32;
                    *self.a.get_unchecked_mut(id as usize) = lo;
                    *self.b.get_unchecked_mut(id as usize) = hi;
                }
                return id;
            }
            let e = e as usize;
            if unsafe { *self.a.get_unchecked(e) == lo && *self.b.get_unchecked(e) == hi } {
                return e as u32;
            }
            h = (h + 1) & self.mask;
        }
    }
}

fn weld(src: &Input) -> Welded {
    let pos = src.pos;
    let nc = pos.len() / 3;
    let (mut x0, mut y0, mut z0) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let (mut x1, mut y1, mut z1) = (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for c in pos.chunks_exact(3) {
        let (x, y, z) = (c[0] as f64, c[1] as f64, c[2] as f64);
        x0 = x0.min(x); x1 = x1.max(x);
        y0 = y0.min(y); y1 = y1.max(y);
        z0 = z0.min(z); z1 = z1.max(z);
    }
    let mut diag = hypot3(x1 - x0, y1 - y0, z1 - z0);
    if !(diag > 0.0) {
        diag = 1.0;
    }

    if let Some((vid, nv)) = src.vid {
        let mut p = vec![0.0f64; nv * 3];
        for (c, &v) in vid.iter().enumerate() {
            let v = v as usize * 3;
            p[v] = pos[c * 3] as f64;
            p[v + 1] = pos[c * 3 + 1] as f64;
            p[v + 2] = pos[c * 3 + 2] as f64;
        }
        return Welded { p, nv, vid: vid.to_vec(), diag };
    }

    let q = diag * 1e-6;
    let mut cap = 1usize;
    while cap < nc * 2 {
        cap <<= 1;
    }
    let mask = (cap - 1) as u32;
    let mut table = vec![-1i32; cap];
    let mut qs: Vec<[i32; 3]> = Vec::with_capacity(nc);
    let mut p: Vec<f64> = Vec::with_capacity(nc * 3);
    let mut vid: Vec<u32> = uninit(nc);
    for c in 0..nc {
        let (x, y, z) = (pos[c * 3] as f64, pos[c * 3 + 1] as f64, pos[c * 3 + 2] as f64);
        let key = [((x - x0) / q).round() as i32, ((y - y0) / q).round() as i32, ((z - z0) / q).round() as i32];
        let mut h = ((key[0] as u32).wrapping_mul(73856093) ^ (key[1] as u32).wrapping_mul(19349663) ^ (key[2] as u32).wrapping_mul(83492791)) & mask;
        loop {
            let e = table[h as usize];
            if e < 0 {
                table[h as usize] = qs.len() as i32;
                vid[c] = qs.len() as u32;
                qs.push(key);
                p.extend_from_slice(&[x, y, z]);
                break;
            }
            if qs[e as usize] == key {
                vid[c] = e as u32;
                break;
            }
            h = (h + 1) & mask;
        }
    }
    Welded { nv: qs.len(), p, vid, diag }
}

fn build_edges(f: &Faces) -> Edges {
    let nc = f.cv.len();
    let mut et = EdgeTable::new(nc);
    let mut corner_edge: Vec<u32> = uninit(nc);
    let mut ef = vec![0u16; nc];
    for fi in 0..f.start.len() {
        let s = f.start[fi] as usize;
        let n = f.count[fi] as usize;
        let cv = &f.cv[s..s + n];
        for i in 0..n {
            let j = if i + 1 == n { 0 } else { i + 1 };
            let e = et.id(cv[i], cv[j]);
            corner_edge[s + i] = e;
            ef[e as usize] = ef[e as usize].saturating_add(1);
        }
    }
    let ne = et.n as usize;
    ef.truncate(ne);
    let open = ef.iter().filter(|&&c| c == 1).count();
    let (mut a, mut b) = (et.a, et.b);
    a.truncate(ne);
    b.truncate(ne);
    Edges { a, b, corner_edge, ef, open }
}

// ---------------------------------------------------------------- T-junctions

#[inline]
fn cell_key(ix: i32, iy: i32, iz: i32) -> i32 {
    ((ix as u32).wrapping_mul(73856093) ^ (iy as u32).wrapping_mul(19349663) ^ (iz as u32).wrapping_mul(83492791)) as i32
}

fn conform(f: &Faces, e: &Edges, w: &Welded) -> Option<Faces> {
    let p = &w.p;
    let mut open_len = 0.0;
    let mut open_count = 0usize;
    let mut candidate = vec![false; w.nv];
    for i in 0..e.a.len() {
        if e.ef[i] != 1 {
            continue;
        }
        let (a, b) = (e.a[i] as usize, e.b[i] as usize);
        candidate[a] = true;
        candidate[b] = true;
        open_len += dist(p, a, b);
        open_count += 1;
    }
    let cell = (open_len / open_count as f64).max(w.diag * 1e-4);
    let mut grid: HashMap<i32, Vec<u32>> = HashMap::new();
    for v in 0..w.nv {
        if candidate[v] {
            let k = cell_key((p[v * 3] / cell).floor() as i32, (p[v * 3 + 1] / cell).floor() as i32, (p[v * 3 + 2] / cell).floor() as i32);
            grid.entry(k).or_default().push(v as u32);
        }
    }

    let nf = f.start.len();
    let mut out_start = vec![0u32; nf];
    let mut out_count = vec![0u32; nf];
    let mut out: Vec<u32> = Vec::with_capacity(f.cv.len() + f.cv.len() / 4);
    let mut hits: Vec<(f64, u32)> = Vec::new();
    let mut inserted = 0usize;
    for fi in 0..nf {
        let s = f.start[fi] as usize;
        let n = f.count[fi] as usize;
        out_start[fi] = out.len() as u32;
        for i in 0..n {
            let a = f.cv[s + i];
            out.push(a);
            if e.ef[e.corner_edge[s + i] as usize] != 1 {
                continue;
            }
            let b = f.cv[s + if i + 1 == n { 0 } else { i + 1 }];
            hits.clear();
            collect_on_segment(p, a, b, &grid, cell, &mut hits);
            if hits.len() > 1 {
                hits.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
            }
            for &(_, v) in hits.iter() {
                if *out.last().unwrap() != v {
                    out.push(v);
                    inserted += 1;
                }
            }
        }
        out_count[fi] = out.len() as u32 - out_start[fi];
    }
    if inserted == 0 {
        None
    } else {
        Some(Faces { start: out_start, count: out_count, cv: out })
    }
}

fn collect_on_segment(p: &[f64], a: u32, b: u32, grid: &HashMap<i32, Vec<u32>>, cell: f64, hits: &mut Vec<(f64, u32)>) {
    let (ai, bi) = (a as usize * 3, b as usize * 3);
    let (ax, ay, az) = (p[ai], p[ai + 1], p[ai + 2]);
    let (dx, dy, dz) = (p[bi] - ax, p[bi + 1] - ay, p[bi + 2] - az);
    let len2 = dx * dx + dy * dy + dz * dz;
    if len2 == 0.0 {
        return;
    }
    let tol2 = len2 * 1e-8;
    let lx = (ax.min(ax + dx) / cell).floor() as i32;
    let hx = (ax.max(ax + dx) / cell).floor() as i32;
    let ly = (ay.min(ay + dy) / cell).floor() as i32;
    let hy = (ay.max(ay + dy) / cell).floor() as i32;
    let lz = (az.min(az + dz) / cell).floor() as i32;
    let hz = (az.max(az + dz) / cell).floor() as i32;
    if (hx - lx + 1) as i64 * (hy - ly + 1) as i64 * (hz - lz + 1) as i64 > 4096 {
        return;
    }
    for ix in lx..=hx {
        for iy in ly..=hy {
            for iz in lz..=hz {
                let Some(list) = grid.get(&cell_key(ix, iy, iz)) else { continue };
                for &v in list {
                    if v == a || v == b {
                        continue;
                    }
                    let vi = v as usize * 3;
                    let (vx, vy, vz) = (p[vi] - ax, p[vi + 1] - ay, p[vi + 2] - az);
                    let t = (vx * dx + vy * dy + vz * dz) / len2;
                    if t <= 1e-6 || t >= 1.0 - 1e-6 {
                        continue;
                    }
                    let (ex, ey, ez) = (vx - t * dx, vy - t * dy, vz - t * dz);
                    if ex * ex + ey * ey + ez * ez < tol2 && !hits.iter().any(|h| h.1 == v) {
                        hits.push((t, v));
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- subdivision

fn subdivide(tags: &[u8], wd: &Welded, f: &Faces, e: &Edges, w: &Weights) -> Mesh {
    let p = &wd.p[..];
    let nv = wd.nv;
    let nf = f.start.len();
    let ne = e.a.len();
    let cv = &f.cv[..];
    let ce = &e.corner_edge[..];
    let use_noise = w.variation != 0.0;
    let displace = w.face != 0.0 || use_noise;
    let ridge = w.ridge != 0.0;

    // --- face points (+ optional displacement along the face normal)
    let mut nc = 0usize;
    let mut max_n = 3usize;
    for &c in &f.count {
        nc += c as usize;
        max_n = max_n.max(c as usize);
    }
    let mut fp: Vec<f64> = uninit(nf * 3);
    let mut fp_out: Vec<f64> = if displace { uninit(nf * 3) } else { Vec::new() };
    let mut fnrm: Vec<f64> = if ridge { uninit(nf * 3) } else { Vec::new() };
    let mut tmp = vec![0.0f64; max_n * 3];
    for fi in 0..nf {
        let s = f.start[fi] as usize;
        let n = f.count[fi] as usize;
        let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
        for &v in &cv[s..s + n] {
            let v = v as usize * 3;
            x += p[v];
            y += p[v + 1];
            z += p[v + 2];
        }
        let nn = n as f64;
        fp[fi * 3] = x / nn;
        fp[fi * 3 + 1] = y / nn;
        fp[fi * 3 + 2] = z / nn;
        if displace || ridge {
            for (i, &v) in cv[s..s + n].iter().enumerate() {
                let v = v as usize * 3;
                tmp[i * 3..i * 3 + 3].copy_from_slice(&p[v..v + 3]);
            }
            let mut nrm = [0.0f64; 3];
            let size = (newell(&tmp, n, &mut nrm) / 2.0).sqrt();
            if ridge {
                fnrm[fi * 3..fi * 3 + 3].copy_from_slice(&nrm);
            }
            if displace {
                let k = if use_noise {
                    w.face + w.variation * noise(fp[fi * 3] * w.frequency, fp[fi * 3 + 1] * w.frequency, fp[fi * 3 + 2] * w.frequency, w.salt)
                } else {
                    w.face
                };
                let d = size * k;
                for c in 0..3 {
                    fp_out[fi * 3 + c] = fp[fi * 3 + c] + nrm[c] * d;
                }
            }
        }
    }
    let fpo: &[f64] = if displace { &fp_out } else { &fp };

    // --- per-edge face-point sums, per-vertex face-point sums
    let mut es = vec![0.0f64; ne * 3];
    let mut en = if ridge { vec![0.0f64; ne * 3] } else { Vec::new() };
    let mut vf = vec![0.0f64; nv * 3];
    let mut vfn = vec![0u32; nv];
    for fi in 0..nf {
        let s = f.start[fi] as usize;
        let n = f.count[fi] as usize;
        let (fx, fy, fz) = (fp[fi * 3], fp[fi * 3 + 1], fp[fi * 3 + 2]);
        for c in s..s + n {
            let ei = ce[c] as usize * 3;
            es[ei] += fx;
            es[ei + 1] += fy;
            es[ei + 2] += fz;
            if ridge {
                en[ei] += fnrm[fi * 3];
                en[ei + 1] += fnrm[fi * 3 + 1];
                en[ei + 2] += fnrm[fi * 3 + 2];
            }
            let v = cv[c] as usize;
            vf[v * 3] += fx;
            vf[v * 3 + 1] += fy;
            vf[v * 3 + 2] += fz;
            vfn[v] += 1;
        }
    }

    // --- edge points + edge-midpoint / crease accumulators per vertex
    let mut ep: Vec<f64> = uninit(ne * 3);
    let mut vr = vec![0.0f64; nv * 3];
    let mut vrn = vec![0u32; nv];
    let mut vc = vec![0.0f64; nv * 3];
    let mut vcn = vec![0u32; nv];
    for i in 0..ne {
        let (av, bv) = (e.a[i] as usize, e.b[i] as usize);
        let (a, b) = (av * 3, bv * 3);
        let crease = e.ef[i] != 2;
        for k in 0..3 {
            let mid = (p[a + k] + p[b + k]) / 2.0;
            ep[i * 3 + k] = if crease { mid } else { mid + ((p[a + k] + p[b + k] + es[i * 3 + k]) / 4.0 - mid) * w.edge };
            vr[a + k] += mid;
            vr[b + k] += mid;
            if crease {
                vc[a + k] += p[b + k];
                vc[b + k] += p[a + k];
            }
        }
        if ridge {
            // lift the edge point along its faces' average normal
            let (nx, ny, nz) = (en[i * 3], en[i * 3 + 1], en[i * 3 + 2]);
            let nl = hypot3(nx, ny, nz);
            if nl > 1e-12 {
                let d = (w.ridge * dist(p, av, bv)) / nl;
                ep[i * 3] += nx * d;
                ep[i * 3 + 1] += ny * d;
                ep[i * 3 + 2] += nz * d;
            }
        }
        vrn[av] += 1;
        vrn[bv] += 1;
        if crease {
            vcn[av] += 1;
            vcn[bv] += 1;
        }
    }

    // --- new vertex points
    let mut np: Vec<f64> = uninit(nv * 3);
    for v in 0..nv {
        let cn = vcn[v];
        let val = vrn[v] as f64;
        let wv = if use_noise {
            w.vertex + w.variation * noise(p[v * 3] * w.frequency + 17.3, p[v * 3 + 1] * w.frequency - 5.1, p[v * 3 + 2] * w.frequency + 9.7, w.salt)
        } else {
            w.vertex
        };
        for k in 0..3 {
            let i = v * 3 + k;
            let pv = p[i];
            np[i] = if cn == 2 {
                (6.0 * pv + vc[i]) / 8.0
            } else if cn > 0 || vrn[v] == 0 {
                pv
            } else {
                pv + ((vf[i] / vfn[v] as f64 + (2.0 * vr[i]) / val + (val - 3.0) * pv) / val - pv) * wv
            };
        }
    }

    // --- quads (vertex, next edge, face, previous edge) + next level topology
    let ne2 = 2 * ne + nc;
    let mut out = Mesh {
        pos: uninit(nc * 12),
        start: uninit(nc),
        count: vec![4u8; nc],
        tag: uninit(nc),
        vid: uninit(nc * 4),
        n_unique: (nv + ne + nf) as u32,
        corner_edge: uninit(nc * 4),
        edge_a: uninit(ne2),
        edge_b: uninit(ne2),
        edge_f: uninit(ne2),
    };
    for i in 0..ne {
        // half-edges: (A end, edge point), (B end, edge point)
        let ept = (nv + i) as u32;
        out.edge_a[2 * i] = e.a[i];
        out.edge_b[2 * i] = ept;
        out.edge_a[2 * i + 1] = e.b[i];
        out.edge_b[2 * i + 1] = ept;
        out.edge_f[2 * i] = e.ef[i];
        out.edge_f[2 * i + 1] = e.ef[i];
    }
    let (e_base, f_base) = (nv as u32, (nv + ne) as u32);
    let half = |edge: usize, v: u32| (2 * edge + (e.a[edge] != v) as usize) as u32;
    let mut q = 0usize;
    for fi in 0..nf {
        let s = f.start[fi] as usize;
        let n = f.count[fi] as usize;
        let t = tags[fi];
        for i in 0..n {
            let c = s + i;
            let cp = s + if i == 0 { n - 1 } else { i - 1 };
            let v = cv[c] as usize;
            let e1 = ce[c] as usize;
            let e0 = ce[cp] as usize;
            let o = q * 4;
            out.start[q] = o as u32;
            out.tag[q] = t;
            let pw = &mut out.pos[o * 3..o * 3 + 12];
            for k in 0..3 {
                pw[k] = np[v * 3 + k] as f32;
                pw[3 + k] = ep[e1 * 3 + k] as f32;
                pw[6 + k] = fpo[fi * 3 + k] as f32;
                pw[9 + k] = ep[e0 * 3 + k] as f32;
            }
            out.vid[o..o + 4].copy_from_slice(&[v as u32, e_base + e1 as u32, f_base + fi as u32, e_base + e0 as u32]);
            // the new quad's edges: half of e1, face edge of c, face edge of cp, half of e0
            let fe = 2 * ne;
            out.corner_edge[o..o + 4].copy_from_slice(&[half(e1, v as u32), (fe + c) as u32, (fe + cp) as u32, half(e0, v as u32)]);
            out.edge_a[fe + c] = e_base + e1 as u32;
            out.edge_b[fe + c] = f_base + fi as u32;
            out.edge_f[fe + c] = 2;
            q += 1;
        }
    }
    out
}

// ---------------------------------------------------------------- helpers

/// Newell normal of an n-gon stored as xyz triples; writes the unit normal
/// into `out` (left untouched when degenerate) and returns 2 × area.
fn newell(v: &[f64], n: usize, out: &mut [f64; 3]) -> f64 {
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let a = i * 3;
        let b = if i + 1 == n { 0 } else { (i + 1) * 3 };
        x += (v[a + 1] - v[b + 1]) * (v[a + 2] + v[b + 2]);
        y += (v[a + 2] - v[b + 2]) * (v[a] + v[b]);
        z += (v[a] - v[b]) * (v[a + 1] + v[b + 1]);
    }
    let len = hypot3(x, y, z);
    if len > 0.0 {
        *out = [x / len, y / len, z / len];
    }
    len
}

#[inline]
fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

#[inline]
fn dist(p: &[f64], a: usize, b: usize) -> f64 {
    hypot3(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2])
}

/// Smooth seeded 3D value noise in [-1, 1] (same as makeNoise in smooth.js).
fn noise(x: f64, y: f64, z: f64, seed: i32) -> f64 {
    #[inline]
    fn lattice(x: i32, y: i32, z: i32, seed: i32) -> f64 {
        let mut h = (x as u32).wrapping_mul(374761393) ^ (y as u32).wrapping_mul(668265263) ^ (z as u32).wrapping_mul(1440662683) ^ seed as u32;
        h = (h ^ (h >> 13)).wrapping_mul(1274126177);
        (h ^ (h >> 16)) as f64 / 2147483647.5 - 1.0
    }
    let fade = |t: f64| t * t * (3.0 - 2.0 * t);
    let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
    let (xi, yi, zi) = (x.floor() as i32, y.floor() as i32, z.floor() as i32);
    let (u, v, w) = (fade(x - xi as f64), fade(y - yi as f64), fade(z - zi as f64));
    let l = |dx: i32, dy: i32, dz: i32| lattice(xi + dx, yi + dy, zi + dz, seed);
    lerp(
        lerp(lerp(l(0, 0, 0), l(1, 0, 0), u), lerp(l(0, 1, 0), l(1, 1, 0), u), v),
        lerp(lerp(l(0, 0, 1), l(1, 0, 1), u), lerp(l(0, 1, 1), l(1, 1, 1), u), v),
        w,
    )
}
