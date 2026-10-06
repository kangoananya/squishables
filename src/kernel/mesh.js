// Face-vertex mesh in flat typed arrays, in the spirit of mola: every face owns
// its own corner coordinates (no shared topology), which keeps rule-based
// operations trivially local and parallelisable. Topology is rebuilt on demand
// (see smooth.js) only for operations that need neighbours.

export const TAGS = ['base', 'cap', 'side', 'inner', 'frame', 'a', 'b', 'apex'];
export const TAG_INDEX = Object.fromEntries(TAGS.map((t, i) => [t, i]));
export const TAG_COLORS = ['#cfc9bd', '#e07a5f', '#5b6b8c', '#81b29a', '#f2cc8f', '#6d9dc5', '#b56576', '#f4f1de'];

export const MAX_FACE_VERTS = 255;

export class FaceLimit extends Error {}

export class FaceBuffer {
  constructor(faceCap = 1024, vertCap = faceCap * 4) {
    this.pos = new Float32Array(vertCap * 3);
    this.start = new Uint32Array(faceCap);
    this.count = new Uint8Array(faceCap);
    this.tag = new Uint8Array(faceCap);
    this.nFaces = 0;
    this.nVerts = 0;
    // optional topology: welded vertex id per corner (set by Catmull–Clark,
    // which knows it for free); lets the next subdivision skip welding
    this.vid = null;
    this.nUnique = 0;
    // optional edge table matching vid: { cornerEdge, a, b, ef } (see smooth.js)
    this.edges = null;
  }

  reserve(faces, verts) {
    if (faces > this.start.length) {
      const cap = Math.max(faces, this.start.length * 2);
      this.start = grow(this.start, cap);
      this.count = grow(this.count, cap);
      this.tag = grow(this.tag, cap);
    }
    if (verts * 3 > this.pos.length) this.pos = grow(this.pos, Math.max(verts * 3, this.pos.length * 2));
  }

  addFace(tag, coords, n) {
    this.vid = null;
    this.edges = null;
    this.reserve(this.nFaces + 1, this.nVerts + n);
    const f = this.nFaces++;
    this.start[f] = this.nVerts;
    this.count[f] = n;
    this.tag[f] = tag;
    const o = this.nVerts * 3;
    for (let k = 0; k < n * 3; k++) this.pos[o + k] = coords[k];
    this.nVerts += n;
  }

  copyFace(src, f) {
    const s = src.start[f] * 3;
    const n = src.count[f];
    this.addFace(src.tag[f], src.pos.subarray(s, s + n * 3), n);
  }

  append(src) {
    if (!src.nFaces) return this;
    this.vid = null;
    this.edges = null;
    const f0 = this.nFaces, v0 = this.nVerts;
    this.reserve(f0 + src.nFaces, v0 + src.nVerts);
    this.pos.set(src.pos.subarray(0, src.nVerts * 3), v0 * 3);
    for (let f = 0; f < src.nFaces; f++) this.start[f0 + f] = src.start[f] + v0;
    this.count.set(src.count.subarray(0, src.nFaces), f0);
    this.tag.set(src.tag.subarray(0, src.nFaces), f0);
    this.nFaces += src.nFaces;
    this.nVerts += src.nVerts;
    return this;
  }

  read(f, out) {
    const s = this.start[f] * 3;
    const n = this.count[f];
    for (let k = 0; k < n * 3; k++) out[k] = this.pos[s + k];
    return n;
  }
}

function grow(arr, cap) {
  const a = new arr.constructor(cap);
  a.set(arr);
  return a;
}
