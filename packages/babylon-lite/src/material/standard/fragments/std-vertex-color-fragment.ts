/** Standard vertex-color fragment — multiplies interpolated RGBA into base color and alpha. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";

export function createStdVertexColorFragment(): ShaderFragment {
    return {
        _id: "std-vertex-color",
        _vertexAttributes: [{ _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 }],
        _varyings: [{ _name: "vColor", _type: "vec4<f32>" }],
        _vertexSlots: {
            VB: `out.vColor = color;`,
        },
        _fragmentSlots: {
            AT: `baseColor *= input.vColor.rgb;
alpha *= input.vColor.a;`,
        },
    };
}
