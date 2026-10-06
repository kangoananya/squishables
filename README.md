# squishables

A browser-based node editor for rule-based mesh subdivision, in the spirit of
[mola](https://github.com/dbt-ethz/mola), Benjamin Dillenburger's subdivision
grammars and Michael Hansmeyer's subdivided platonic solids. Geometry runs in a
Rust/WebAssembly kernel inside a Web Worker; everything happens in the browser.

```
npm start            # http://localhost:5173  (Node 18+, no install needed)
npm run bench        # headless timing of every preset (--js for the JS kernel)
npm run parity       # Rust/WASM vs JS kernel: must match bit for bit
npm run build:wasm   # rebuild wasm/ from kernel-rs (needs Rust + wasm32 target)
```

The built `wasm/squishables_kernel.wasm` is committed, so the site runs without
a Rust toolchain; the JS kernel is the fallback and the reference.

## Using it

Grasshopper / vvvv-style graph: double-click the canvas to search for a node,
drag between slots to wire, right-click for the menu. Drag a number left/right
to scrub it, click it to type (decimal commas work). Only what reaches an
**Output** node is drawn and exported; the selected node's result is outlined
green.

| Nodes | |
|---|---|
| Primitive | Box, Prism, Plane, Platonic solid (5 Platonic + cuboctahedron, rhombic dodecahedron, truncated octahedron, icosidodecahedron) |
| Split | Grid, Quads, Split In Two (`first` / `second`), Frame (`border` / `inner`) |
| Extrude | Extrude (`cap` / `sides`), Spike |
| Subdivide | Smooth (Catmull–Clark), Subdivide (weighted: vertex / edge / face, ridge, noise variation) |
| Logic | Filter (`yes` / `no`) with Facing, Chance, Tag Is, Size, Height, And / Or / Not |
| Loop | Loop Start / Loop End (orange wire): re-runs the nodes between them |
| Mesh | Merge, Set Tag, Move, Output |

Ops with several outputs also have `all`. Subdivision welds the face soup and
repairs T-junctions left by face-local splits, so Catmull–Clark runs on a
crack-free mesh. Alternating weighted subdivisions inside a loop give the
Hansmeyer-style folds (see the *Platonic* / *Archimedean* examples).

**View** (top right of the viewport): shaded, shaded + contours, contour lines
(z, x, y or radial shells), point cloud and wireframe, with hidden-line removal;
gradient backgrounds (presets or custom) and PNG export. URL options:
`?preset=N&display=contours&bg=paper&color=clay`.

Export STL or OBJ (n-gons, grouped by tag).

## Hosting

A static site: upload `index.html`, `src/` and `wasm/` to any web host
(GitHub Pages, Netlify, your own server). It must be served over http(s);
three.js and LiteGraph load from the jsDelivr CDN.

## Performance

- **Incremental evaluation**: the worker caches every node's outputs under a key
  of its type, params and everything upstream; an edit only recomputes the
  nodes downstream of it. Selection changes reuse the last result.
- **Rust/WASM subdivision** (`kernel-rs/`): dependency-free crate, plain C ABI,
  hand-written glue in `src/kernel/wasm.js`; built with SIMD128, bulk-memory
  and non-trapping float→int. Mirrors `smooth.js` exactly.
- **Topology hand-over**: each subdivision passes welded vertex ids and its edge
  table to the next, so repeated subdivision skips welding and edge hashing.
- **Lean rendering**: indexed geometry over the face buffer's own corners, flat
  shading derived on the GPU, outlines reuse the positions.

Chrome, worker only: woven dodecahedron 3 loops 37 → 11 ms, 4 loops (≈1M faces)
327 → 179 ms, JS → Rust (`tools/worker-bench.html`).

## Structure

```
index.html
src/main.js            node editor (LiteGraph), saving, examples
src/viewer.js          three.js viewport, worker, toolbar
src/display.js         display modes, backgrounds, View panel
src/graph-presets.js   examples · src/graph-chain.js recipe → graph builder
src/worker.js          evaluation off the main thread
src/kernel/            geometry kernel (no DOM; runs in the worker or Node)
  mesh.js              FaceBuffer: flat typed arrays, face-vertex soup like mola
  ops.js · params.js   face operations + their parameter specs
  primitives.js        primitives incl. convex-hull solids
  nodes.js · graph.js  node types + memoised dataflow evaluator with loops
  apply.js             ops on face sets, filters, conditions, seeded randomness
  smooth.js            weld + T-junction repair + weighted Catmull–Clark
  export.js            render buffers, contours, point clouds, STL, OBJ
  wasm.js              bridge to the Rust kernel
kernel-rs/             Rust crate → wasm/squishables_kernel.wasm
tools/                 bench, parity, build-wasm, contact sheet, worker bench
```

## Roadmap

- Port the face ops, filters and render buffers to Rust and keep meshes in
  WASM memory between nodes
- WASM threads (needs COOP/COEP headers — not available on GitHub Pages)
- High-resolution PNG export; JavaScript class view of each node for teaching OOP
