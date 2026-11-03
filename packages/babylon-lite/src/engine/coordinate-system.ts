/**
 * Coordinate-system handedness — default variant: left-handed, fixed at build time.
 *
 * Engine modules never import this file by path: they import `#coordinate-system`, which the
 * package's `imports` map resolves per bundler condition:
 *
 *  - default           → this file: left-handed;
 *  - `babylon-lite-rh` → `coordinate-system-rh.ts`: right-handed.
 *
 * Both variants export `_rightHanded` as a constant, so the bundler inlines it in every chunk and
 * folds each handedness test to the chosen branch: neither pays a byte or a runtime test.
 *
 * Model: a right-handed engine renders the world exactly as a left-handed engine renders the
 * Z-mirrored world. The mirror is folded into the camera's view matrix (`V = Sz·V_RH`,
 * `Sz = diag(1, 1, -1)`), so the projection stays the left-handed one and the view space every shader
 * sees is the usual left-handed one (+X right, +Y up, +Z forward). Because that view matrix mirrors,
 * triangles reach the rasterizer with reversed winding, so camera-pass pipelines flip `frontFace`.
 *
 * See `docs/lite/architecture/61-right-handed-system.md`.
 */

/** @internal `true` when the engine is right-handed, `null` when it is left-handed. */
export const _rightHanded: true | null = null;
