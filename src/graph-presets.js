// Example graphs: nodes with positions + links [from, fromSlot, to, toSlot].
// toCompiled() turns one into the evaluator format (used headlessly by bench).

import { chain, sub } from './graph-chain.js';

const n = (id, type, x, y, params = {}) => ({ id, type, pos: [x, y], params });
const S = (solid) => ({ solid, radius: 1 });
const smoothLoop = (times) => ({ loop: times, body: [['smooth']] });

export const GRAPH_PRESETS = [
  {
    name: 'Platonic: tetrahedron, folded and smoothed',
    seed: 1,
    nodes: [
      n(1, 'platonic', 40, 72, { solid: 'tetrahedron', radius: 1 }),
      n(10, 'subdivide', 201, 274, { vertex: 1.5, edge: 0, face: 0, ridge: 0, variation: 0, frequency: 2 }),
      n(2, 'loop_start', 356, 40),
      n(3, 'subdivide', 639, 77, { vertex: 3, edge: 1, face: 0.5, ridge: 0.1, variation: 0, frequency: 2 }),
      n(4, 'subdivide', 882, 70, { vertex: -0.2, edge: 0, face: -0.9, ridge: 0, variation: 0, frequency: 2 }),
      n(5, 'loop_end', 1139, 77, { times: 3 }),
      n(6, 'loop_start', 1389, 77),
      n(7, 'smooth', 1639, 77),
      n(8, 'loop_end', 1889, 77, { times: 3 }),
      n(9, 'output', 2139, 77),
    ],
    links: [
      [1, 'faces', 10, 'faces'], [10, 'faces', 2, 'faces'],
      [2, 'faces', 3, 'faces'], [3, 'faces', 4, 'faces'], [4, 'faces', 5, 'faces'], [2, 'loop', 5, 'loop'],
      [5, 'faces', 6, 'faces'], [6, 'faces', 7, 'faces'], [7, 'faces', 8, 'faces'], [6, 'loop', 8, 'loop'],
      [8, 'faces', 9, 'faces'],
    ],
  },
  {
    name: 'Platonic: woven dodecahedron (loop)',
    seed: 1,
    nodes: [
      n(1, 'platonic', 40, 120, { solid: 'dodecahedron', radius: 1 }),
      n(2, 'loop_start', 300, 140),
      n(3, 'subdivide', 520, 100, { vertex: 1.3, edge: 1, face: 0.45 }),
      n(4, 'subdivide', 780, 100, { vertex: 0.2, edge: 1, face: -0.35 }),
      n(5, 'loop_end', 1040, 140, { times: 3 }),
      n(6, 'output', 1280, 140),
    ],
    links: [
      [1, 'faces', 2, 'faces'], [2, 'faces', 3, 'faces'], [3, 'faces', 4, 'faces'],
      [4, 'faces', 5, 'faces'], [2, 'loop', 5, 'loop'], [5, 'faces', 6, 'faces'],
    ],
  },
  // Hansmeyer-style: alternating weightings fold each level into the last;
  // a final smoothing pass turns the folds into legible ridges
  chain('Platonic: ridged cube', 1, S('cube'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.2 }), sub(-0.3, 1, -0.3)] }, sub(1, 1, 0)]),
  chain('Platonic: terraced octahedron', 1, S('octahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.2 }), sub(-0.3, 1, -0.3)] }, ['smooth']]),
  chain('Archimedean: icosidodecahedron rosettes', 1, S('icosidodecahedron'), [{ loop: 2, body: [sub(1, 1, 0.6, { ridge: 0.15 }), sub(-0.4, 1, -0.3)] }, sub(1, 1, 0.5, { ridge: 0.15 }), ['smooth']]),
  chain('Catalan: rhombic dodecahedron folds', 1, S('rhombic dodecahedron'), [{ loop: 2, body: [sub(1.3, 1, 0.5), sub(-0.2, 1, -0.5)] }, smoothLoop(2)]),
  chain('Archimedean: cuboctahedron crystal', 1, S('cuboctahedron'), [{ loop: 2, body: [sub(1, 1, 0.6), sub(-0.4, 1, -0.4)] }, smoothLoop(2)]),
  chain('Archimedean: truncated octahedron, noise-varied', 2, S('truncated octahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { variation: 0.8, frequency: 1.2 }), sub(-0.3, 1, -0.3)] }, ['smooth']]),
  chain('Platonic: tetrahedron lace', 1, S('tetrahedron'), [{ loop: 3, body: [sub(1, 1, 0.5, { ridge: 0.1 }), sub(-0.4, 1, -0.4)] }, smoothLoop(2)]),
];

export function toCompiled(preset) {
  const nodes = {};
  for (const node of preset.nodes) nodes[node.id] = { type: node.type, params: node.params, inputs: {} };
  for (const [from, fromSlot, to, toSlot] of preset.links) nodes[to].inputs[toSlot] = [from, fromSlot];
  const outputs = preset.nodes.filter((node) => node.type === 'output').map((node) => node.id);
  return { seed: preset.seed, nodes, outputs };
}
