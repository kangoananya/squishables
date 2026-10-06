# squishables

A node editor for rule-based mesh subdivision, in the browser.

## Usage

- **Add a node:** double-click the canvas and search.
- **Wire:** drag from an output slot to an input slot.
- **Menu:** right-click.
- **Change a value:** drag a number left or right, or click it to type.
- Only what reaches an **Output** node is drawn and exported.
- Start from **/examples/** in the toolbar.

## Nodes

| Type | Nodes |
|---|---|
| Primitive | Box, Prism, Plane, Platonic solid |
| Split | Grid, Quads, Split In Two, Frame |
| Extrude | Extrude, Spike |
| Subdivide | Smooth, Subdivide (weighted) |
| Logic | Filter with Facing, Chance, Tag Is, Size, Height, And / Or / Not |
| Loop | Loop Start / Loop End: repeats the nodes between them |
| Mesh | Merge, Set Tag, Move, Output |

## View and export

- **/view/** (top right of the viewport): shaded, contours, points or wireframe, plus backgrounds and PNG export.
- **/export stl/** and **/export obj/** save the mesh.
- **/save/** and **/open/** store the graph as a file.
