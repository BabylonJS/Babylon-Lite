/** PointLight — position-based light with falloff.
 *  Plain data, no scene knowledge (pillar 4b).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createLightBase, applyWorldMatrixAccessors, ObservableVec3 } from "./light-base.js";
import type { Mat4 } from "../math/types.js";
import type { Mat4Storage } from "../math/types.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

export interface PointLight extends LightBase {
    readonly lightType: "point";
    position: ObservableVec3;
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
    const m = allocateMat4() as unknown as Mat4Storage;
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    const _localMatrix = m as unknown as Mat4;
    const { wm, onDirty, lvs } = createLightBase(() => {
        m[12] = light.position.x;
        m[13] = light.position.y;
        m[14] = light.position.z;
        return _localMatrix;
    });

    const light = applyWorldMatrixAccessors<PointLight>(
        {
            lightType: "point" as const,
            children: [] as SceneNode[],
            position: new ObservableVec3(position[0], position[1], position[2], onDirty),
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            range: Number.MAX_VALUE,

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
        wm,
        lvs
    );
    return light;
}
