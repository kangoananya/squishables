// Example graphs: nodes with positions + links [from, fromSlot, to, toSlot].
// toCompiled() turns one into the evaluator format (used headlessly by bench).

import { chain, sub } from './graph-chain.js';

const n = (id, type, x, y, params = {}) => ({ id, type, pos: [x, y], params });
const S = (solid) => ({ solid, radius: 1 });
const smoothLoop = (times) => ({ loop: times, body: [['smooth']] });

export const GRAPH_PRESETS = [
  {
    name: 'Tower',
    seed: 1,
    nodes: [
      n(1, 'box', 40, 200, { width: 1, depth: 1, height: 2.6 }),
      n(2, 'facing', 40, 380, { dir: 'side' }),
      n(3, 'filter', 300, 220),
      n(4, 'grid', 520, 80, { u: 3, v: 7 }),
      n(5, 'frame', 760, 80, { amount: 0.35 }),
      n(6, 'extrude', 1000, 120, { height: -0.25, taper: 0.1 }),
      n(7, 'facing', 300, 420, { dir: 'up' }),
      n(8, 'filter', 520, 340),
      n(9, 'extrude', 760, 320, { height: 0.5, taper: 0.45 }),
      n(10, 'spike', 1000, 330, { height: 1.2 }),
      n(11, 'merge', 1260, 200),
      n(12, 'output', 1480, 200),
    ],
    links: [
      [1, 'faces', 3, 'faces'], [2, 'condition', 3, 'condition'],
      [3, 'yes', 4, 'faces'], [4, 'faces', 5, 'faces'], [5, 'inner', 6, 'faces'],
      [3, 'no', 8, 'faces'], [7, 'condition', 8, 'condition'], [8, 'yes', 9, 'faces'], [9, 'cap', 10, 'faces'],
      [6, 'all', 11, 'a'], [5, 'border', 11, 'b'], [10, 'faces', 11, 'c'], [9, 'sides', 11, 'd'], [8, 'no', 11, 'e'],
      [11, 'faces', 12, 'faces'],
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
  {
    name: 'Grotto (branching + smooth)',
    seed: 7,
    nodes: [
      n(1, 'box', 40, 120),
      n(2, 'loop_start', 260, 120),
      n(3, 'quads', 470, 100),
      n(4, 'loop_end', 680, 120, { times: 2 }),
      n(5, 'chance', 680, 300, { p: 85 }),
      n(6, 'filter', 900, 140),
      n(7, 'extrude', 1110, 60, { height: 0.4, taper: 0.35, jitter: 0.6 }),
      n(8, 'frame', 1350, 40, { amount: 0.4 }),
      n(9, 'extrude', 1590, 20, { height: -0.3, taper: 0.3 }),
      n(10, 'merge', 1830, 160),
      n(11, 'smooth', 2050, 160),
      n(12, 'output', 2260, 160),
    ],
    links: [
      [1, 'faces', 2, 'faces'], [2, 'faces', 3, 'faces'], [3, 'faces', 4, 'faces'], [2, 'loop', 4, 'loop'],
      [4, 'faces', 6, 'faces'], [5, 'condition', 6, 'condition'],
      [6, 'yes', 7, 'faces'], [7, 'cap', 8, 'faces'], [8, 'inner', 9, 'faces'],
      [9, 'all', 10, 'a'], [8, 'border', 10, 'b'], [7, 'sides', 10, 'c'], [6, 'no', 10, 'd'],
      [10, 'faces', 11, 'faces'], [11, 'faces', 12, 'faces'],
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
