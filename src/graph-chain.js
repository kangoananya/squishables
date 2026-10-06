// Builds a graph preset from a linear recipe, laying the nodes out left to
// right. Steps:
//   ['subdivide', params]                 any single-input node (`all` output for ops that have it)
//   { loop: 3, body: [steps] }            Loop Start … Loop End
//   { recess: extrudeParams, frame }      Frame → Extrude(inner) → Merge(with border)
export function chain(name, seed, solid, steps) {
  const nodes = [];
  const links = [];
  let id = 0;
  let x = 40;
  const add = (type, params = {}, y = 140) => {
    nodes.push({ id: ++id, type, pos: [x, y], params });
    x += 250;
    return id;
  };
  const wire = ([from, slot], to, toSlot = 'faces') => links.push([from, slot, to, toSlot]);
  const ALL = new Set(['extrude', 'frame', 'split']);

  let cur = [add('platonic', solid), 'faces'];
  const run = (list) => {
    for (const step of list) {
      if (step.loop) {
        const start = add('loop_start');
        wire(cur, start);
        cur = [start, 'faces'];
        run(step.body);
        const end = add('loop_end', { times: step.loop });
        wire(cur, end);
        links.push([start, 'loop', end, 'loop']);
        cur = [end, 'faces'];
      } else if (step.recess) {
        const frame = add('frame', step.frame ?? {});
        wire(cur, frame);
        const ex = add('extrude', step.recess, 20);
        links.push([frame, 'inner', ex, 'faces']);
        const merge = add('merge');
        links.push([ex, 'all', merge, 'a'], [frame, 'border', merge, 'b']);
        cur = [merge, 'faces'];
      } else {
        const [type, params, slot] = step;
        const n = add(type, params);
        wire(cur, n);
        cur = [n, slot ?? (ALL.has(type) ? 'all' : 'faces')];
      }
    }
  };
  run(steps);
  wire(cur, add('output'));
  return { name, seed, nodes, links };
}

export const sub = (vertex, edge, face, extra = {}) => ['subdivide', { vertex, edge, face, ...extra }];
