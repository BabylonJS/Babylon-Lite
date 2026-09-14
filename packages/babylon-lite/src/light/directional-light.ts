/** DirectionalLight — plain data (pillar 4b: no scene reference).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import { ObservableVec3, createLightBase, applyLightBase, copyLightBase, writeWorldLightDirection } from "./light-base.js";

export interface DirectionalLight extends LightBase {
    readonly lightType: "directional";
    readonly direction: ObservableVec3;
    readonly position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
}

/**
 * Creates a directional light shining along `direction` (a parallel light source, like the sun).
 * @param direction - World-space direction the light travels along.
 * @param intensity - Scalar multiplier applied to the light's diffuse and specular contribution.
 * @returns Plain `DirectionalLight` data to be added to a scene via `addToScene`.
 */
export function createDirectionalLight(direction: [number, number, number], intensity = 1): DirectionalLight {
    const { node, lvs } = createLightBase([0, 0, 0]);
    const light = applyLightBase<DirectionalLight>(
        node,
        {
            lightType: "directional" as const,
            direction: new ObservableVec3(direction[0], direction[1], direction[2], lvs.b),
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            _cloneNode: () => {
                const clone = createDirectionalLight([light.direction.x, light.direction.y, light.direction.z], light.intensity);
                clone.diffuse = [...light.diffuse];
                clone.specular = [...light.specular];
                copyLightBase(light, clone);
                return clone;
            },

            _writeLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                // Direction = local direction transformed by world matrix
                writeWorldLightDirection(data, o, w, light.direction);
                data[o + 3] = 1;
                data[o + 4] = light.diffuse[0] * light.intensity;
                data[o + 5] = light.diffuse[1] * light.intensity;
                data[o + 6] = light.diffuse[2] * light.intensity;
                data[o + 7] = Number.MAX_VALUE;
                data[o + 8] = light.specular[0] * light.intensity;
                data[o + 9] = light.specular[1] * light.intensity;
                data[o + 10] = light.specular[2] * light.intensity;
            },
        },
        lvs
    );
    return light;
}
