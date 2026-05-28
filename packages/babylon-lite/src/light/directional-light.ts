/** DirectionalLight — plain data (pillar 4b: no scene reference).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase, LightBaseInternal } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createLightBase, applyWorldMatrixAccessors, ObservableVec3 } from "./light-base.js";
import { localMatrixFromDirection } from "./light-matrix.js";
import type { Mat4 } from "../math/types.js";

export interface DirectionalLight extends LightBase {
    readonly lightType: "directional";
    direction: ObservableVec3;
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
}

export function createDirectionalLight(direction: [number, number, number], intensity = 1): DirectionalLight {
    // Lazy `_localMatrix`: allocated via the bound precision policy on first
    // worldMatrix read so HPM-on lights produce F64 storage without a
    // per-light rebind closure. `applyWorldMatrixAccessors` forwards
    // `_rebindAllocator` to wm, so the world cache is rebound on attach.
    let _localMatrix: Mat4 | null = null;
    const { wm, onDirty, lvs } = createLightBase(() => {
        if (!_localMatrix) {
            const a = (light as unknown as LightBaseInternal)._boundPolicy?.allocator;
            _localMatrix = (a ? a.allocate() : new Float32Array(16)) as unknown as Mat4;
        }
        return localMatrixFromDirection(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z, _localMatrix);
    });

    const light = applyWorldMatrixAccessors<DirectionalLight>(
        {
            lightType: "directional" as const,
            children: [] as SceneNode[],
            direction: new ObservableVec3(direction[0], direction[1], direction[2], onDirty),
            position: new ObservableVec3(0, 0, 0, onDirty),
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,

            _writeLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                // Direction = worldMatrix column 2
                data[o] = w[8]!;
                data[o + 1] = w[9]!;
                data[o + 2] = w[10]!;
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
        wm,
        lvs
    );
    return light;
}
