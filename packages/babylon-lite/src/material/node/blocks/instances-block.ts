/** InstancesBlock — picks between per-instance and uniform world matrix.
 *
 *  When instancing is enabled the pipeline builder wires `in.world0..world3`
 *  (4x vec4 attribute) and the block's output becomes the reconstructed mat4x4.
 *  Otherwise the output is the scene-provided uniform `_NME_WORLD_MATRIX_`.
 *
 *  The choice is made at pipeline-build time by reading serialized flag
 *  `isThinInstance` or by inspecting mesh metadata; for graph-walk purposes we
 *  always emit the sentinel, and the pipeline builder rewrites it.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "InstancesBlock",
    stage: "vertex",
    emit(_block, outputName, _stage, state, _ctx) {
        if (outputName === "instanceID") {
            if (state.hasInstances) {
                state.usesInstanceIndex = true;
                return { expr: "f32(instanceIndex)", type: "f32" };
            }
            return { expr: "0.0", type: "f32" };
        }
        if (state.hasInstances) {
            for (let index = 0; index < 4; index++) {
                const name = `world${index}`;
                if (!state.vertexAttributes.some((attribute) => attribute._name === name)) {
                    state.vertexAttributes.push({
                        _name: name,
                        _type: "vec4<f32>",
                        _gpuFormat: "float32x4",
                        _arrayStride: 64,
                        _stepMode: "instance",
                        _bufferGroup: "ti-matrix",
                        _offset: index * 16,
                    });
                }
            }
            return { expr: "(meshU.world * mat4x4<f32>(in.world0, in.world1, in.world2, in.world3))", type: "mat4f" };
        }
        return { expr: "meshU.world", type: "mat4f" };
    },
};
