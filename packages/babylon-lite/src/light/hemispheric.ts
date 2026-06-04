/** Hemispheric light data.
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createLightBase, applyWorldMatrixAccessors, ObservableVec3 } from "./light-base.js";
import { localMatrixFromDirection } from "./light-matrix.js";
import type { Mat4 } from "../math/types.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

export interface HemisphericLight extends LightBase {
    readonly lightType: "hemispheric";
    direction: ObservableVec3;
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

/** Create a hemispheric light. Returns plain data — caller adds to scene.
 *  Matches Babylon.js HemisphericLight behavior. */
export function createHemisphericLight(direction: [number, number, number] = [0, 1, 0], intensity: number = 1.0): HemisphericLight {
    const _localMatrix: Mat4 = allocateMat4();
    const { wm, onDirty, lvs } = createLightBase(() => {
        return localMatrixFromDirection(light.direction.x, light.direction.y, light.direction.z, 0, 0, 0, _localMatrix);
    });

    const light = applyWorldMatrixAccessors<HemisphericLight>(
        {
            lightType: "hemispheric" as const,
            children: [] as SceneNode[],
            direction: new ObservableVec3(direction[0], direction[1], direction[2], onDirty),
            intensity,
            diffuseColor: [1, 1, 1] as [number, number, number],
            specularColor: [1, 1, 1] as [number, number, number],
            groundColor: [0, 0, 0] as [number, number, number],

            _writeLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                // Direction = worldMatrix column 2
                data[o] = w[8]!;
                data[o + 1] = w[9]!;
                data[o + 2] = w[10]!;
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
        wm,
        lvs
    );
    return light;
}
