/** PointLight — position-based light with falloff.
 *  Plain data, no scene knowledge (pillar 4b).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import type { ObservableVec3 } from "./light-base.js";
import { createLightBase, applyLightBase, copyLightBase } from "./light-base.js";

export interface PointLight extends LightBase {
    readonly lightType: "point";
    readonly position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

/**
 * Creates a point light that emits in all directions from `position` with distance falloff.
 * @param position - World-space position of the light.
 * @param intensity - Scalar multiplier applied to the light's diffuse and specular contribution.
 * @returns Plain `PointLight` data to be added to a scene via `addToScene`.
 */
export function createPointLight(position: [number, number, number], intensity = 1.0): PointLight {
    const { node, lvs } = createLightBase(position);
    const light = applyLightBase<PointLight>(
        node,
        {
            lightType: "point" as const,
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            range: Number.MAX_VALUE,
            _cloneNode: () => {
                const clone = createPointLight([light.position.x, light.position.y, light.position.z], light.intensity);
                clone.diffuse = [...light.diffuse];
                clone.specular = [...light.specular];
                clone.range = light.range;
                copyLightBase(light, clone);
                return clone;
            },

            _writeLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                data[o] = w[12]!;
                data[o + 1] = w[13]!;
                data[o + 2] = w[14]!;
                data[o + 3] = 0;
                data[o + 4] = light.diffuse[0] * light.intensity;
                data[o + 5] = light.diffuse[1] * light.intensity;
                data[o + 6] = light.diffuse[2] * light.intensity;
                data[o + 7] = light.range;
                data[o + 8] = light.specular[0] * light.intensity;
                data[o + 9] = light.specular[1] * light.intensity;
                data[o + 10] = light.specular[2] * light.intensity;
            },
        },
        lvs
    );
    return light;
}
