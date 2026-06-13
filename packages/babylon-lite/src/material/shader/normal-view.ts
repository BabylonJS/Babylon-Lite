/** ShaderMaterial view helper that re-renders a custom material as a geometric
 *  NORMAL buffer (a lightweight, single-attachment alternative to the full
 *  geometry renderer for the screen-space-effect — e.g. cavity — use case).
 *
 *  Babylon-Lite does not own a ShaderMaterial's fragment, so this view cannot
 *  post-patch the user fragment the way the Standard/PBR geometry views do.
 *  Instead it REUSES the source material's vertex stage (so instancing,
 *  displacement, and all bindings stay correct) and SUBSTITUTES the fragment
 *  with a generated `mainFragment` that writes the per-fragment GEOMETRIC normal
 *  (`normalize(cross(dpdx(P), dpdy(P)))`, P = a world-position varying the
 *  source already emits) into a single colour attachment, encoded `n*0.5+0.5`.
 *
 *  The substitution rides the existing shader pipeline unchanged: the renderable
 *  reads `material.fragmentSource`, which the view overrides; the prelude (scene
 *  UBO, system/custom uniforms, samplers) is still prepended, so `scene.view` is
 *  available and the source's bind-group layout is reused (the normal fragment
 *  simply doesn't reference the material's textures). Render the view into an
 *  rgba8/rgba16f colour + depth target; cleared alpha 0 marks "no geometry".
 *
 *  Requirement (validated by the caller): the source vertex stage must output
 *  the world position as a `vec3<f32>` varying at `worldPosLocation` (default
 *  `@location(0)`, named `vWorldPos`). Every Lite ShaderMaterial that wants a
 *  normal buffer must keep that varying at a stable location. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { ShaderMaterial } from "./shader-material.js";

/** Configuration for {@link createShaderNormalMaterialView}. */
export interface ShaderNormalViewConfig {
    /** Name of the world-position varying the source vertex stage emits. Default `"vWorldPos"`. */
    readonly worldPosVarying?: string;
    /** `@location()` of that varying in the vertex output struct. Default `0`. */
    readonly worldPosLocation?: number;
    /** Output space of the encoded normal: `"view"` (default — ready for
     *  Blender-style screen-space curvature) or `"world"`. */
    readonly space?: "view" | "world";
}

/** WGSL `mainFragment` that emits the encoded geometric normal. */
function buildNormalFragment(varying: string, location: number, space: "view" | "world"): string {
    const nExpr = space === "world" ? "nW" : "normalize((scene.view * vec4<f32>(nW, 0.0)).xyz)";
    return `struct CavityNormalIn { @location(${location}) ${varying}: vec3<f32>, };
@fragment fn mainFragment(input: CavityNormalIn) -> @location(0) vec4<f32> {
  let nW = normalize(cross(dpdx(input.${varying}), dpdy(input.${varying})));
  let n = ${nExpr};
  return vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0);
}`;
}

/** Wrap a ShaderMaterial as a normal-buffer view. The returned view renders the
 *  source's geometry (instancing/displacement intact) but writes the geometric
 *  normal instead of the material's colour. Idempotent-friendly: create one per
 *  source and reuse it. */
export function createShaderNormalMaterialView(source: ShaderMaterial, config: ShaderNormalViewConfig = {}): MaterialView {
    const view = createMaterialView(source, { features: 0 });
    const frag = buildNormalFragment(config.worldPosVarying ?? "vWorldPos", config.worldPosLocation ?? 0, config.space ?? "view");
    Object.defineProperty(view, "fragmentSource", { value: frag, enumerable: true, configurable: true });
    return view;
}
