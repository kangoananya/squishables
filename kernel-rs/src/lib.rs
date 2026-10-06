//! squishables geometry kernel for WebAssembly.
//!
//! Plain C ABI, no dependencies: JS allocates input buffers in wasm memory
//! with `mm_alloc`, calls an operation, then copies the result out through
//! `mm_out_ptr` / `mm_out_len` and releases it with `mm_out_clear`.
//!
//! Every algorithm mirrors its JS counterpart in `src/kernel/` (same hashes,
//! same iteration order, f64 internally), so both produce the same mesh.

mod smooth;

use std::cell::RefCell;

/// A face soup in the same layout as the JS `FaceBuffer`.
#[derive(Default)]
pub struct Mesh {
    pub pos: Vec<f32>,
    pub start: Vec<u32>,
    pub count: Vec<u8>,
    pub tag: Vec<u8>,
    /// welded vertex id per corner (empty when unknown)
    pub vid: Vec<u32>,
    pub n_unique: u32,
    /// edge table: edge id per corner (corner → next corner), endpoints
    /// (lo, hi vertex id) and face count per edge (empty when unknown)
    pub corner_edge: Vec<u32>,
    pub edge_a: Vec<u32>,
    pub edge_b: Vec<u32>,
    pub edge_f: Vec<u16>,
}

thread_local! {
    static OUT: RefCell<Mesh> = RefCell::new(Mesh::default());
}

// ---------------------------------------------------------------- memory

/// Allocates `bytes` (4-byte aligned) for JS to fill.
#[no_mangle]
pub extern "C" fn mm_alloc(bytes: usize) -> *mut u8 {
    let mut v: Vec<u32> = Vec::with_capacity(bytes.div_ceil(4).max(1));
    let ptr = v.as_mut_ptr() as *mut u8;
    std::mem::forget(v);
    ptr
}

/// Frees a block from `mm_alloc` (same `bytes`).
///
/// # Safety
/// `ptr` must come from `mm_alloc(bytes)` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn mm_free(ptr: *mut u8, bytes: usize) {
    drop(Vec::from_raw_parts(ptr as *mut u32, 0, bytes.div_ceil(4).max(1)));
}

// ---------------------------------------------------------------- results

/// Pointer to output array `which`: 0 pos (f32), 1 start (u32), 2 count (u8),
/// 3 tag (u8), 4 vid (u32), 5 corner_edge (u32), 6 edge_a (u32), 7 edge_b
/// (u32), 8 edge_f (u16).
#[no_mangle]
pub extern "C" fn mm_out_ptr(which: u32) -> *const u8 {
    OUT.with(|o| {
        let o = o.borrow();
        match which {
            0 => o.pos.as_ptr() as *const u8,
            1 => o.start.as_ptr() as *const u8,
            2 => o.count.as_ptr(),
            3 => o.tag.as_ptr(),
            4 => o.vid.as_ptr() as *const u8,
            5 => o.corner_edge.as_ptr() as *const u8,
            6 => o.edge_a.as_ptr() as *const u8,
            7 => o.edge_b.as_ptr() as *const u8,
            _ => o.edge_f.as_ptr() as *const u8,
        }
    })
}

/// Element count of output array `which` (see `mm_out_ptr`); 9 = n_unique.
#[no_mangle]
pub extern "C" fn mm_out_len(which: u32) -> u32 {
    OUT.with(|o| {
        let o = o.borrow();
        (match which {
            0 => o.pos.len(),
            1 => o.start.len(),
            2 => o.count.len(),
            3 => o.tag.len(),
            4 => o.vid.len(),
            5 => o.corner_edge.len(),
            6 => o.edge_a.len(),
            7 => o.edge_b.len(),
            8 => o.edge_f.len(),
            _ => o.n_unique as usize,
        }) as u32
    })
}

#[no_mangle]
pub extern "C" fn mm_out_clear() {
    OUT.with(|o| *o.borrow_mut() = Mesh::default());
}

// ---------------------------------------------------------------- operations

/// Weighted Catmull–Clark (see `smooth.rs`). Returns 0 on success (result in
/// the output slot) or 1 when the result would exceed `max_faces`.
///
/// # Safety
/// Pointers must reference `n_verts * 3` floats, `n_faces` entries each for
/// start / count / tag, `n_verts` entries for `vid` and `corner_edge`, and
/// `n_edges` entries for `edge_a` / `edge_b` / `edge_f` (null when unknown).
#[no_mangle]
pub unsafe extern "C" fn mm_catmull_clark(
    pos: *const f32,
    n_verts: u32,
    start: *const u32,
    count: *const u8,
    tag: *const u8,
    n_faces: u32,
    vid: *const u32,
    n_unique: u32,
    corner_edge: *const u32,
    edge_a: *const u32,
    edge_b: *const u32,
    edge_f: *const u16,
    n_edges: u32,
    vertex: f64,
    edge: f64,
    face: f64,
    ridge: f64,
    variation: f64,
    frequency: f64,
    salt: i32,
    max_faces: u32,
) -> u32 {
    if n_verts > max_faces {
        return 1;
    }
    let nv = n_verts as usize;
    let nf = n_faces as usize;
    let input = smooth::Input {
        pos: std::slice::from_raw_parts(pos, nv * 3),
        start: std::slice::from_raw_parts(start, nf),
        count: std::slice::from_raw_parts(count, nf),
        tag: std::slice::from_raw_parts(tag, nf),
        vid: if vid.is_null() || n_unique == 0 { None } else { Some((std::slice::from_raw_parts(vid, nv), n_unique as usize)) },
        edges: if corner_edge.is_null() {
            None
        } else {
            let ne = n_edges as usize;
            Some(smooth::EdgesIn {
                corner_edge: std::slice::from_raw_parts(corner_edge, nv),
                a: std::slice::from_raw_parts(edge_a, ne),
                b: std::slice::from_raw_parts(edge_b, ne),
                ef: std::slice::from_raw_parts(edge_f, ne),
            })
        },
    };
    let w = smooth::Weights { vertex, edge, face, ridge, variation, frequency, salt };
    let out = smooth::catmull_clark(&input, &w);
    OUT.with(|o| *o.borrow_mut() = out);
    0
}
