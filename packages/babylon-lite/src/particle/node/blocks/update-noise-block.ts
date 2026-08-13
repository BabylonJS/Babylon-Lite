import { column } from "../../particle-buffer.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import { loadNpeTextureContent } from "../npe-texture-content.js";
import type { NpeTextureContent, NpeTextureValue } from "../npe-value.js";
import type { Vec3 } from "../../../math/types.js";

function sampleRed(map: NpeTextureContent, u: number, v: number): number {
    const x = (((Math.abs(u) * 0.5 + 0.5) * map.width) % map.width) | 0;
    const y = (((Math.abs(v) * 0.5 + 0.5) * map.height) % map.height) | 0;
    return map.data[(x + y * map.width) * 4]! / 255;
}

/** `UpdateNoiseBlock` — perturb particle direction from fixed per-particle texture samples. */
export const updateNoiseBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const source = ctx.input(block, "noiseTexture")(0) as unknown as NpeTextureValue;
        const defaultStrength: Vec3 = { x: 100, y: 100, z: 100 };
        const strength = ctx.input(block, "strength", () => defaultStrength)(0) as Vec3 | null;
        if (!strength) {
            return;
        }
        const coord1X = column(buffer, "noise.coord1.x", Float64Array);
        const coord1Y = column(buffer, "noise.coord1.y", Float64Array);
        const coord1Z = column(buffer, "noise.coord1.z", Float64Array);
        const coord2X = column(buffer, "noise.coord2.x", Float64Array);
        const coord2Y = column(buffer, "noise.coord2.y", Float64Array);
        const coord2Z = column(buffer, "noise.coord2.z", Float64Array);
        const coordinateId = column(buffer, "noise.id", Uint32Array);
        const coordinateValid = column(buffer, "noise.valid", Uint8Array);
        let noise: NpeTextureContent | null = null;

        if (source?.url) {
            ctx.addBuildPromise(
                loadNpeTextureContent(source)
                    .then((content) => {
                        noise = content;
                    })
                    .catch(() => undefined)
            );
        }

        system.updateSteps.push((i) => {
            if (!noise) {
                return;
            }
            const id = buffer.id[i]!;
            if (!coordinateValid[i] || coordinateId[i] !== id) {
                coord1X[i] = Math.random();
                coord1Y[i] = Math.random();
                coord1Z[i] = Math.random();
                coord2X[i] = Math.random();
                coord2Y[i] = Math.random();
                coord2Z[i] = Math.random();
                coordinateId[i] = id;
                coordinateValid[i] = 1;
            }

            const step = system._scaledStep;
            buffer.dirX[i] = buffer.dirX[i]! + (sampleRed(noise, coord1X[i]!, coord1Y[i]!) * 2 - 1) * strength.x * step;
            buffer.dirY[i] = buffer.dirY[i]! + (sampleRed(noise, coord1Z[i]!, coord2X[i]!) * 2 - 1) * strength.y * step;
            buffer.dirZ[i] = buffer.dirZ[i]! + (sampleRed(noise, coord2Y[i]!, coord2Z[i]!) * 2 - 1) * strength.z * step;
        });
    },
};
