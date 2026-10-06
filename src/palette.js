// Node colours from a 1933 Japanese dictionary of colour combinations. Each
// category gets a pale tone for its title bar and a deep tone of the same hue
// for the square; bodies stay white. Deeppink is the accent (selection).

export const ACCENT = '#ff1493';

// node categories: title bar and title square
export const CATEGORY_COLORS = {
  Primitive: { title: '#ebd3a2', box: '#bb7125' }, // Ivory Buff / Raw Sienna
  Split: { title: '#96d1aa', box: '#1a7444' }, // Cobalt Green / Diamine Green
  Extrude: { title: '#a7d4e4', box: '#007190' }, // Pale King's Blue / Antwarp Blue
  Subdivide: { title: '#f8b6ba', box: '#b73f74' }, // Corinthian Pink / Rosolanc Purple
  Logic: { title: '#b5b1d8', box: '#6450a1' }, // Grayish Lavender / Blue Violet
  Loop: { title: '#eea78c', box: '#ae5224' }, // Vinaceous Cinnamon / Burnt Sienna
  Mesh: { title: '#e4e4e4', box: '#111314' }, // grey / black
};

// wires by slot type; conditions and loops match their node categories
export const LINK_COLORS = {
  faces: '#9a9a9a',
  condition: CATEGORY_COLORS.Logic.box,
  loop: CATEGORY_COLORS.Loop.box,
};
