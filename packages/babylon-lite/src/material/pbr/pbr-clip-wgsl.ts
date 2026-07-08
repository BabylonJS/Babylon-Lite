/**
 * PBR clip-plane WGSL — the scene clip-plane discard block.
 *
 * Dynamically imported by `pbr-renderable` ONLY when `scene.clipPlane` is set (via `setClipPlane`),
 * then threaded into the PBR template as a plain string (the same pattern fog uses). This keeps the
 * clip WGSL out of the bundles of PBR scenes that don't clip — a static `import` into `pbr-template`
 * would defeat tree-shaking and inflate every PBR scene (see GUIDANCE §4c′).
 *
 * Parity notes (matches Babylon.js `clipPlaneFragment` / Lite's `ClipPlanesBlock`):
 *  - Discards fragments whose signed distance to the plane is positive:
 *    `dot(vec4(worldPos, 1.0), clipPlane) > 0.0 → discard`.
 *  - `dot()` is linear in `worldPos`, so computing it from the perspective-interpolated `worldPos`
 *    varying in the fragment stage is identical to interpolating a per-vertex scalar distance.
 *  - When no clip plane is set the scene UBO's `clipPlane` slot stays `(0,0,0,0)`, so this block is a
 *    safe no-op; it is nevertheless compile-gated out of non-clipping scenes to save bundle bytes.
 */

/** Clip-plane discard, emitted at the top of the PBR fragment main (reads `scene.clipPlane`). */
export const PBR_CLIP_BLOCK = `if(dot(vec4<f32>(input.worldPos,1.0),scene.clipPlane)>0.0){discard;}`;
