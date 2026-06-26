/** Standard Vertex-Color Fragment — multiplies baseColor by the per-vertex color before lighting,
 *  matching BJS StandardMaterial. The `color` attribute is float32x4 RGBA (stride 16) — the
 *  engine-wide vertex-color layout (glTF/PBR, procedural meshes, node materials, and the FBX loader
 *  all emit RGBA) — and the rgb is used to modulate base color (vertex alpha is forced to 1.0). */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_VERTEX_COLOR } from "../standard-flags.js";
import { _installStdExtFeature } from "../std-feature-hooks.js";

export function createStdVertexColorFragment(): ShaderFragment {
    return {
        _id: "std-vcolor",
        _vertexAttributes: [{ _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 }],
        _varyings: [{ _name: "vColor", _type: "vec3<f32>" }],
        _vertexSlots: { VB: `out.vColor = color.rgb;` },
        // Backtick (not double-quote) so the bundle's WGSL identifier mangler rewrites
        // `baseColor` here to match the mangled declaration in the standard template.
        _fragmentSlots: { AT: `\nbaseColor = baseColor * input.vColor;` },
    };
}

/** Registry extension gated on `HAS_VERTEX_COLOR`. Vertex color is a vertex attribute (not a
 *  UBO/texture), so there is no group-1 binding — the `_bind`/`_textures` hooks are omitted and
 *  the shared StdExt bind/texture loops skip it. It DOES contribute a draw-time vertex buffer,
 *  bound generically via `_bindVertexBuffers` (mirrors the layout the composer emits for the
 *  `color` attribute). */
export const stdVertexColorExt: StdExt = {
    _id: "std-vcolor",
    _phase: "mesh",
    _feature: HAS_VERTEX_COLOR,
    _frag: () => createStdVertexColorFragment(),
    _bindVertexBuffers(mesh, pass, slot) {
        const g = mesh._gpu;
        if (g.colorBuffer) {
            pass.setVertexBuffer(slot++, g.colorBuffer, g._vbLayout?._c?._offset);
        }
        return slot;
    },
};

// Loading this chunk wires the vertex-color feature bit into the bundle (folds the renderable's
// feature-OR branch in scenes that never enable vertex color). See standard-renderable._stdExtBits.
_installStdExtFeature(HAS_VERTEX_COLOR);
