/**
 * Thin Instance Fragment
 *
 * Shared between PBR and Standard materials.
 * Replaces the regex-based string surgery in pbr-thin-instance-ext.ts
 * with clean declarative vertex attributes and slot injection.
 *
 * Zero bytes in bundles for scenes that don't use thin instances.
 */

import type { ShaderFragment } from "../fragment-types.js";

/**
 * Create a thin-instance fragment.
 * @param hasInstanceColor - Whether meshes have per-instance color data.
 */
export function createThinInstanceFragment(hasInstanceColor: boolean): ShaderFragment {
    const attrs = [
        {
            _name: "world0",
            _type: "vec4<f32>",
            _gpuFormat: "float32x4" as GPUVertexFormat,
            _arrayStride: 64,
            _stepMode: "instance" as GPUVertexStepMode,
            _bufferGroup: "ti-matrix",
            _offset: 0,
        },
        {
            _name: "world1",
            _type: "vec4<f32>",
            _gpuFormat: "float32x4" as GPUVertexFormat,
            _arrayStride: 64,
            _stepMode: "instance" as GPUVertexStepMode,
            _bufferGroup: "ti-matrix",
            _offset: 16,
        },
        {
            _name: "world2",
            _type: "vec4<f32>",
            _gpuFormat: "float32x4" as GPUVertexFormat,
            _arrayStride: 64,
            _stepMode: "instance" as GPUVertexStepMode,
            _bufferGroup: "ti-matrix",
            _offset: 32,
        },
        {
            _name: "world3",
            _type: "vec4<f32>",
            _gpuFormat: "float32x4" as GPUVertexFormat,
            _arrayStride: 64,
            _stepMode: "instance" as GPUVertexStepMode,
            _bufferGroup: "ti-matrix",
            _offset: 48,
        },
    ];

    if (hasInstanceColor) {
        attrs.push({
            _name: "instanceColor",
            _type: "vec4<f32>",
            _gpuFormat: "float32x4" as GPUVertexFormat,
            _arrayStride: 16,
            _stepMode: "instance" as GPUVertexStepMode,
            _bufferGroup: "ti-color",
            _offset: 0,
        });
    }

    return {
        _id: "thin-instance",

        _vertexAttributes: attrs,

        _varyings: hasInstanceColor ? [{ _name: "vInstanceColor", _type: "vec4<f32>" }] : [],

        _vertexSlots: {
            VW: `let instanceWorld = mat4x4<f32>(world0, world1, world2, world3);\nfinalWorld = mesh.world * instanceWorld;`,
            VB: hasInstanceColor ? `out.vInstanceColor = instanceColor;` : "",
        },

        _fragmentSlots: hasInstanceColor
            ? {
                  AT: `baseColor *= input.vInstanceColor.rgb;\nalpha *= input.vInstanceColor.a;`,
              }
            : {},
    };
}
