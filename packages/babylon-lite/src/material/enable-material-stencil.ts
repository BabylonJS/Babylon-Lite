/**
 * Opt-in entry point for per-material stencil state.
 *
 * Stencil (a {@link StencilState} baked into a material's main-pass pipeline — used to mask/discard
 * fragments, e.g. portals or decals) is an *explicit* opt-in so stencil-free scenes stay BYTE-IDENTICAL to a
 * build without it. The always-fetched Standard / PBR / Shader pipeline builders reference stencil only
 * through a module-local resolver hook that is `null` until this function installs it; with the hook absent
 * from the bundle the tree-shaker + minifier fold every stencil branch away. Calling `enableMaterialStencil`
 * links the resolver (and pulls in its descriptor-building code) into all three pipelines.
 *
 * Contract: attach stencil to materials via `material.stencil = { ... }`, then call this once AFTER creating
 * the materials/meshes and BEFORE `registerScene(scene)`. It is process-global and idempotent — no engine or
 * scene argument is needed.
 */

import { _resolveStencil } from "./stencil-state.js";
import { _installPbrStencilResolver } from "./pbr/pbr-pipeline.js";
import { _installStandardStencilResolver } from "./standard/standard-pipeline.js";
import { _installShaderStencilResolver } from "./shader/shader-pipeline.js";

/**
 * Enable per-material stencil state for Standard, PBR, and Shader materials.
 *
 * A writer material uses `compare: "always"` + `passOp: "increment-clamp"` to stamp the stencil buffer where
 * it draws; a tester material uses `compare: "equal"` to draw only where the stencil is still the pass's
 * default reference of 0 (i.e. where the writer did NOT draw). No dynamic stencil reference is needed.
 *
 * ```ts
 * const mask = createStandardMaterial();
 * mask.stencil = { passOp: "increment-clamp" }; // writes 1 where it draws
 * const masked = createStandardMaterial();
 * masked.stencil = { compare: "equal" };        // draws only where stencil is still 0
 *
 * enableMaterialStencil(); // ← opt-in, before registerScene
 * await registerScene(scene);
 * ```
 *
 * @public
 */
export function enableMaterialStencil(): void {
    _installPbrStencilResolver(_resolveStencil);
    _installStandardStencilResolver(_resolveStencil);
    _installShaderStencilResolver(_resolveStencil);
}
