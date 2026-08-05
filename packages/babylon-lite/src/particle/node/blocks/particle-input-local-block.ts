import { transformCoordinatesToRef } from "../../../math/mat4-transform.js";
import { column } from "../../particle-buffer.js";
import type { Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** `LocalPositionUpdated` contextual source for emitter-local particle systems. */
export const particleInputLocalBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        if (!state.isLocal) {
            throw new Error("NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal");
        }
        const buffer = state.buffer!;
        const system = state.system!;
        const emitterWorldMatrix = state.emitterWorldMatrix;
        const localX = column(buffer, "localPosition.x", Float32Array);
        const localY = column(buffer, "localPosition.y", Float32Array);
        const localZ = column(buffer, "localPosition.z", Float32Array);
        const localId = column(buffer, "localPosition.id", Uint32Array);
        const localValid = column(buffer, "localPosition.valid", Uint8Array);
        system._seedLocalPosition = (i) => {
            localX[i] = buffer.posX[i]!;
            localY[i] = buffer.posY[i]!;
            localZ[i] = buffer.posZ[i]!;
            localId[i] = buffer.id[i]!;
            localValid[i] = 1;
        };
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        ctx.setOutput(block.id, "output", (i) => {
            const id = buffer.id[i]!;
            if (localValid[i] === 0 || localId[i] !== id) {
                throw new Error("NodeParticle: LocalPositionUpdated read before local shape position creation");
            }
            const step = buffer.age[i] === 0 ? 0 : system._scaledStep;
            localX[i] = localX[i]! + buffer.dirX[i]! * step;
            localY[i] = localY[i]! + buffer.dirY[i]! * step;
            localZ[i] = localZ[i]! + buffer.dirZ[i]! * step;
            transformCoordinatesToRef(localX[i]!, localY[i]!, localZ[i]!, emitterWorldMatrix, scratch);
            buffer.posX[i] = scratch.x;
            buffer.posY[i] = scratch.y;
            buffer.posZ[i] = scratch.z;
            return scratch;
        });
    },
};
