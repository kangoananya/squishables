// Parameter specs shared by primitives and operations. The GUI builds its
// controls from these, and the kernel resolves values (with defaults) from them.

export const num = (value, min, max, step = 0.01) => ({ type: 'number', value, min, max, step });
export const int = (value, min, max) => ({ type: 'number', value, min, max, step: 1 });
export const bool = (value) => ({ type: 'bool', value });
export const choice = (value, options) => ({ type: 'enum', value, options });

export function resolveParams(spec, given = {}) {
  const out = {};
  for (const [k, s] of Object.entries(spec)) out[k] = given[k] ?? s.value;
  return out;
}
