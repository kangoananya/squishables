// Trial recipes for tuning presets with tools/sheet.html.
import { chain, sub } from '../src/graph-chain.js';

const S = (solid) => ({ solid, radius: 1 });
const smooth = (n) => ({ loop: n, body: [['smooth']] });

export const CANDIDATES = [
  chain('ridged cube', 1, S('cube'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.2 }), sub(-0.3, 1, -0.3)] }, sub(1, 1, 0)]),
  chain('terraced octahedron', 1, S('octahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.2 }), sub(-0.3, 1, -0.3)] }, smooth(1)]),
  chain('rhombic folds', 1, S('rhombic dodecahedron'), [{ loop: 3, body: [sub(1.3, 1, 0.5), sub(-0.2, 1, -0.5)] }, smooth(1)]),
  chain('icosidodeca rosettes', 1, S('icosidodecahedron'), [{ loop: 2, body: [sub(1, 1, 0.6, { ridge: 0.15 }), sub(-0.4, 1, -0.3)] }, sub(1, 1, 0.5, { ridge: 0.15 }), smooth(1)]),
  chain('varied trunc. octa', 2, S('truncated octahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { variation: 0.8, frequency: 1.2 }), sub(-0.3, 1, -0.3)] }, smooth(1)]),
  chain('tetra lace', 1, S('tetrahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.1 }), sub(-0.4, 1, -0.4)] }, smooth(2)]),
  chain('cubocta crystal', 1, S('cuboctahedron'), [{ loop: 3, body: [sub(1, 1, 0.6), sub(-0.4, 1, -0.4)] }, smooth(1)]),
  chain('recessed rhombic', 1, S('rhombic dodecahedron'), [{ recess: { height: -0.4, taper: 0.3 }, frame: { amount: 0.4 } }, { loop: 2, body: [sub(1.2, 1, 0.4), sub(0, 1, -0.3)] }, smooth(1)]),
];
