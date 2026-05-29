/** GsShaderFragment for Gaussian-Splatting GPU picking.
 *
 *  Lite equivalent of BJS `GaussianSplattingGpuPickingMaterialPlugin.pure.ts`:
 *  reads a per-mesh `pickingColor: vec3f` uniform (the 24-bit pick id encoded
 *  as normalised RGB) and writes it as the fragment color, discarding splat
 *  fragments whose gaussian alpha is below 0.001 so picks pass cleanly through
 *  transparent splats.
 *
 *  This is the shader-injection half of the plugin.  The CPU half — owning the
 *  picking-color UBO, allocating the bind group and rendering with multi-target
 *  output / no blending — lives in `gs-picking-pipeline.ts`.  Splitting the
 *  plugin this way mirrors how BJS's `MaterialPluginBase.getCustomCode` (shader
 *  side) and `bindForSubMesh` (binding side) interact.
 *
 *  Compound (multi-part) picking is **not** supported in Lite (matches the
 *  minimal-port scope confirmed for scene 129). */

import type { GsShaderFragment } from "./gaussian-splatting-mesh.js";

/** Lite port of `GaussianSplattingGpuPickingMaterialPlugin`'s non-compound path:
 *  declare a `picking` UBO at `@group(2) @binding(0)` (allocated by the picking
 *  pipeline) and override the fragment colour with the per-mesh pick id. */
export const gsGpuPickingFragment: GsShaderFragment = {
    id: "gsGpuPicking",
    helperFunctions: /* wgsl */ `
struct GsPickingU { pickingColor: vec3<f32> };
@group(2) @binding(0) var<uniform> picking: GsPickingU;
`,
    fragmentSlots: {
        GS_FRAGMENT_BEFORE_FRAGCOLOR: /* wgsl */ `
            if (finalColor.a < 0.001) { discard; }
            finalColor = vec4<f32>(picking.pickingColor, 1.0);
        `,
    },
};

/** CPU helper matching BJS `GaussianSplattingGpuPickingMaterialPlugin.EncodeIdToColor`. */
export function encodeIdToColor(id: number): [number, number, number] {
    return [((id >> 16) & 0xff) / 255, ((id >> 8) & 0xff) / 255, (id & 0xff) / 255];
}
