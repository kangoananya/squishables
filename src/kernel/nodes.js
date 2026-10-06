// Node types for the graph editor. Pure data: the UI builds LiteGraph nodes
// from it and the evaluator (graph.js) interprets it.
//
// Slot types: 'faces' (a face set), 'condition' (a per-face test), 'loop'
// (the wire that pairs a Loop Start with its Loop End).

import { OPS } from './ops.js';
import { PRIMITIVES } from './primitives.js';
import { TAGS } from './mesh.js';
import { num, int, choice } from './params.js';

const F = (name) => [name, 'faces'];
const COND = (name) => [name, 'condition'];

const primitive = (shape) => ({
  cat: 'Primitive', title: PRIMITIVES[shape].label, kind: 'primitive', shape,
  inputs: [], outputs: [F('faces')], params: PRIMITIVES[shape].params,
});

// `roles` maps output slot → op output role; 'all' = every resulting face
const faceOp = (cat, op, title, roles) => ({
  cat, title, kind: 'op', op, roles,
  inputs: [F('faces')], outputs: Object.keys(roles).map(F), params: OPS[op].params,
});

const condition = (title, cond, params) => ({ cat: 'Logic', title, kind: 'cond', cond, inputs: [], outputs: [COND('condition')], params });

export const NODE_TYPES = {
  box: primitive('box'),
  prism: primitive('prism'),
  plane: primitive('plane'),
  platonic: primitive('platonic'),

  grid: faceOp('Split', 'grid', 'Split Grid', { faces: 'all' }),
  quads: faceOp('Split', 'quads', 'Split Quads', { faces: 'all' }),
  split: faceOp('Split', 'split', 'Split In Two', { first: 'a', second: 'b', all: 'all' }),
  frame: faceOp('Split', 'frame', 'Frame', { border: 'frame', inner: 'inner', all: 'all' }),

  extrude: faceOp('Extrude', 'extrude', 'Extrude', { cap: 'cap', sides: 'side', all: 'all' }),
  spike: faceOp('Extrude', 'point', 'Spike', { faces: 'all' }),

  smooth: { ...faceOp('Subdivide', 'smooth', 'Smooth', { faces: 'all' }), kind: 'global' },
  subdivide: { ...faceOp('Subdivide', 'subdivide', 'Subdivide (weighted)', { faces: 'all' }), kind: 'global' },

  filter: { cat: 'Logic', title: 'Filter', kind: 'filter', inputs: [F('faces'), COND('condition')], outputs: [F('yes'), F('no')], params: {} },
  facing: condition('Facing', 'facing', { dir: choice('up', ['up', 'down', 'side']) }),
  chance: condition('Chance %', 'chance', { p: int(50, 0, 100) }),
  is_tag: condition('Tag Is', 'tag', { tag: choice('cap', TAGS) }),
  size: condition('Size', 'size', { cmp: choice('gt', ['gt', 'lt']), value: num(0.2, 0, 100) }),
  height: condition('Height', 'z', { cmp: choice('gt', ['gt', 'lt']), value: num(1, -100, 100) }),
  and: { cat: 'Logic', title: 'And', kind: 'combine', cond: 'and', inputs: [COND('a'), COND('b')], outputs: [COND('condition')], params: {} },
  or: { cat: 'Logic', title: 'Or', kind: 'combine', cond: 'or', inputs: [COND('a'), COND('b')], outputs: [COND('condition')], params: {} },
  not: { cat: 'Logic', title: 'Not', kind: 'combine', cond: 'not', inputs: [COND('a')], outputs: [COND('condition')], params: {} },

  loop_start: { cat: 'Loop', title: 'Loop Start', kind: 'loop_start', inputs: [F('faces')], outputs: [F('faces'), ['loop', 'loop']], params: {} },
  loop_end: { cat: 'Loop', title: 'Loop End', kind: 'loop_end', inputs: [F('faces'), ['loop', 'loop']], outputs: [F('faces')], params: { times: int(3, 0, 20) } },

  merge: { cat: 'Mesh', title: 'Merge', kind: 'merge', inputs: ['a', 'b', 'c', 'd', 'e', 'f'].map(F), outputs: [F('faces')], params: {} },
  tag: { cat: 'Mesh', title: 'Set Tag', kind: 'tag', inputs: [F('faces')], outputs: [F('faces')], params: { tag: choice('a', TAGS) } },
  move: { cat: 'Mesh', title: 'Move', kind: 'move', inputs: [F('faces')], outputs: [F('faces')], params: { x: num(0, -50, 50), y: num(0, -50, 50), z: num(0, -50, 50) } },
  output: { cat: 'Mesh', title: 'Output', kind: 'output', inputs: [F('faces')], outputs: [], params: {} },
};
