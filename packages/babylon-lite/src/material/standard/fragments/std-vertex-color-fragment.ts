/** Standard RGBA vertex-color fragment.
 *
 *  Installed through the canonical `enableStandardVertexColors()` opt-in (master
 *  #430) via the `_stdVertexColorFragment` seam. RGB is ALWAYS applied
 *  (`baseColor *= input.vColor.rgb`). Alpha is consumed ONLY when the mesh opts in
 *  via `mesh.hasVertexAlpha` (Babylon `VERTEXALPHA`): the fragment then multiplies
 *  the output alpha by `vColor.a` and folds `vColor.a` into the alpha-test cutoff.
 *  Without the opt-in the vertex colour is RGB-only — matching BJS, which gates
 *  every vertex-alpha effect behind the VERTEXALPHA define. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";

export function createStdVertexColorFragment(hasDiffuse = false, hasVertexAlpha = false): ShaderFragment {
    // RGB is always applied. Alpha (and the vertex-alpha alpha-test) is appended only
    // under the VERTEXALPHA opt-in — matching BJS, which gates every vertex-alpha
    // effect behind the VERTEXALPHA define.
    let at = "baseColor *= input.vColor.rgb;";
    if (hasVertexAlpha) {
        const alphaTest = hasDiffuse ? "_ds.a * input.vColor.a" : "input.vColor.a";
        at += `\nalpha *= input.vColor.a;\nif (${alphaTest} < mat.aCut) { discard; }`;
    }
    return {
        _id: "std-vertex-color",
        _vertexAttributes: [{ _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 }],
        _varyings: [{ _name: "vColor", _type: "vec4<f32>" }],
        _vertexSlots: { VB: "out.vColor = color;" },
        _fragmentSlots: { AT: at },
    };
}
