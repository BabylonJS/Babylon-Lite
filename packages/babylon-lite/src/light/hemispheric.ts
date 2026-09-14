/** Hemispheric light data.
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import { ObservableVec3, createLightBase, applyLightBase, copyLightBase, writeWorldLightDirection } from "./light-base.js";

export interface HemisphericLight extends LightBase {
    readonly lightType: "hemispheric";
    readonly direction: ObservableVec3;
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

/** Create a hemispheric light. Returns plain data — caller adds to scene.
 *  Matches Babylon.js HemisphericLight behavior. */
export function createHemisphericLight(direction: [number, number, number] = [0, 1, 0], intensity: number = 1.0): HemisphericLight {
    const { node, lvs } = createLightBase([0, 0, 0]);
    const light = applyLightBase<HemisphericLight>(
        node,
        {
            lightType: "hemispheric" as const,
            direction: new ObservableVec3(direction[0], direction[1], direction[2], lvs.b),
            intensity,
            diffuseColor: [1, 1, 1] as [number, number, number],
            specularColor: [1, 1, 1] as [number, number, number],
            groundColor: [0, 0, 0] as [number, number, number],
            _cloneNode: () => {
                const clone = createHemisphericLight([light.direction.x, light.direction.y, light.direction.z], light.intensity);
                clone.diffuseColor = [...light.diffuseColor];
                clone.specularColor = [...light.specularColor];
                clone.groundColor = [...light.groundColor];
                copyLightBase(light, clone);
                return clone;
            },

            _writeLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                // Direction = local direction transformed by world matrix
                writeWorldLightDirection(data, o, w, light.direction);
                data[o + 3] = 3;
                data[o + 4] = light.diffuseColor[0] * light.intensity;
                data[o + 5] = light.diffuseColor[1] * light.intensity;
                data[o + 6] = light.diffuseColor[2] * light.intensity;
                data[o + 8] = light.specularColor[0] * light.intensity;
                data[o + 9] = light.specularColor[1] * light.intensity;
                data[o + 10] = light.specularColor[2] * light.intensity;
                data[o + 12] = light.groundColor[0] * light.intensity;
                data[o + 13] = light.groundColor[1] * light.intensity;
                data[o + 14] = light.groundColor[2] * light.intensity;
            },
        },
        lvs
    );
    return light;
}
