/** NodeMaterial render-feature bits. */

export const NODE_NO_COLOR_OUTPUT = 1 << 0;
export const NODE_ESM_SHADOW_OUTPUT = 1 << 1;
/** Set by {@link createNodeGeometryMaterialView}. The geometry renderable
 *  re-emits the graph from the GeometryTextureOutputBlock terminal and the
 *  node pipeline emits a multi-attachment `FragmentOutput` instead of a single
 *  colour. Zero impact on scenes that never create a geometry view. */
export const NODE_GEOMETRY_OUTPUT = 1 << 2;
