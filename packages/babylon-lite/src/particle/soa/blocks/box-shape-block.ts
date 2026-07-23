import { randomRange } from "../../../math/random-range.js";
import { transformCoordinatesToRef, transformNormalToRef } from "../../../math/mat4-transform.js";
import type { Vec3 } from "../../../math/types.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `BoxShapeBlock` (SoA) — emits from a box: the position slot draws a uniform point in
 * `[minEmitBox, maxEmitBox]`, the direction slot a uniform direction between `direction1`/`direction2`,
 * each via `randomRange` (which skips the RNG when min === max). The emitter world matrix is baked into
 * birth position and direction. Local-space graphs use the separate local shape evaluator.
 */
export const boxShapeBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = state.system!;
        const buffer = state.buffer!;

        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const minBoxGetter = ctx.input(block, "minEmitBox", () => ({ x: -0.5, y: -0.5, z: -0.5 }));
        const maxBoxGetter = ctx.input(block, "maxEmitBox", () => ({ x: 0.5, y: 0.5, z: 0.5 }));
        const emitterWorldMatrix = state.emitterWorldMatrix;

        const posX = buffer.posX;
        const posY = buffer.posY;
        const posZ = buffer.posZ;
        const dirX = buffer.dirX;
        const dirY = buffer.dirY;
        const dirZ = buffer.dirZ;
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };

        system.createPosition = (i) => {
            const minBox = minBoxGetter(i) as Vec3;
            const minX = minBox.x;
            const minY = minBox.y;
            const minZ = minBox.z;
            const maxBox = maxBoxGetter(i) as Vec3;
            const rx = randomRange(minX, maxBox.x);
            const ry = randomRange(minY, maxBox.y);
            const rz = randomRange(minZ, maxBox.z);
            transformCoordinatesToRef(rx, ry, rz, emitterWorldMatrix, scratch);
            posX[i] = scratch.x;
            posY[i] = scratch.y;
            posZ[i] = scratch.z;
        };

        system.createDirection = (i) => {
            const dir1 = dir1Getter(i) as Vec3;
            const minX = dir1.x;
            const minY = dir1.y;
            const minZ = dir1.z;
            const dir2 = dir2Getter(i) as Vec3;
            const rx = randomRange(minX, dir2.x);
            const ry = randomRange(minY, dir2.y);
            const rz = randomRange(minZ, dir2.z);
            transformNormalToRef(rx, ry, rz, emitterWorldMatrix, scratch);
            dirX[i] = scratch.x;
            dirY[i] = scratch.y;
            dirZ[i] = scratch.z;
        };
    },
};
