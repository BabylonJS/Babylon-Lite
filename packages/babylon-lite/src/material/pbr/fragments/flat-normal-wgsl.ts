/** Flat (geometric) normal WGSL — dynamically imported.
 *
 *  The glTF spec requires a primitive WITHOUT a NORMAL attribute to be flat-shaded
 *  (one normal per triangle face), matching Babylon.js's default. Instead of
 *  de-indexing the geometry, the face normal is derived per-fragment from the
 *  screen-space derivatives of the world position and oriented toward the viewer.
 *
 *  Isolated here (string only loaded when a scene actually contains a no-NORMAL
 *  mesh) so scenes whose assets always provide NORMAL — the common case, incl.
 *  scene1 — never bundle this WGSL: zero bundle cost.
 */
export const FLAT_NORMAL_WGSL = `var N_geom=normalize(cross(dpdx(input.worldPos), dpdy(input.worldPos)));
if (dot(N_geom, normalize(scene.vEyePosition.xyz - input.worldPos)) < 0.0) { N_geom = -N_geom; }
var N=N_geom;`;
