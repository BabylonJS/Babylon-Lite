/** PointLight — position-based light with falloff.
 *  Plain data, no scene knowledge (pillar 4b).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4Translation } from "../math/mat4.js";
import { createLightBase, applyWorldMatrixAccessors, ObservableVec3 } from "./light-base.js";

export interface PointLight extends LightBase {
    readonly lightType: "point";
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

export function createPointLight(position: [number, number, number], intensity = 1.0): PointLight {
    const { wm, onDirty, lvs } = createLightBase(() => mat4Translation(light.position.x, light.position.y, light.position.z));

    const light = applyWorldMatrixAccessors<PointLight>(
        {
            lightType: "point" as const,
            children: [] as SceneNode[],
            position: new ObservableVec3(position[0], position[1], position[2], onDirty),
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            range: Number.MAX_VALUE,

            _registerPbr: async () => {
                const { registerPointPbrLight } = await import("./point-pbr.js");
                registerPointPbrLight();
            },
            _writeStandardLightUbo: (data: Float32Array, offset: number) => {
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
