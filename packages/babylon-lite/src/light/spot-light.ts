/** SpotLight — cone-shaped light with position, direction, angle, and exponent falloff.
 *  Plain data, no scene knowledge (pillar 4b).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createLightBase, applyWorldMatrixAccessors, ObservableVec3 } from "./light-base.js";
import { localMatrixFromDirection } from "./light-matrix.js";
import type { Mat4 } from "../math/types.js";

export interface SpotLight extends LightBase {
    readonly lightType: "spot";
    position: ObservableVec3;
    direction: ObservableVec3;
    /** Full cone angle in radians. */
    angle: number;
    /** Falloff exponent — higher = sharper spotlight. */
    exponent: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

export function createSpotLight(position: [number, number, number], direction: [number, number, number], angle: number, exponent: number, intensity = 1.0): SpotLight {
    const _localMatrix = new Float32Array(16) as Mat4;
    const { wm, onDirty, lvs } = createLightBase(() =>
        localMatrixFromDirection(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z, _localMatrix)
    );

    // Pre-compute cosHalfAngle; updated via Object.defineProperty when angle changes
    let _angle = angle;
    let _cosHalfAngle = Math.cos(angle * 0.5);

    const light = applyWorldMatrixAccessors<SpotLight>(
        {
            lightType: "spot" as const,
            children: [] as SceneNode[],
            position: new ObservableVec3(position[0], position[1], position[2], onDirty),
            direction: new ObservableVec3(direction[0], direction[1], direction[2], onDirty),
            angle: 0 as number, // placeholder — overridden by defineProperty below
            exponent,
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            range: Number.MAX_VALUE,

            _registerPbr: async () => {
                // PBR multi-light not yet implemented; no-op for now
            },
            _writeStandardLightUbo: (data: Float32Array, offset: number) => {
                const o = offset;
                const w = light.worldMatrix;
                // Position = worldMatrix column 3
                data[o] = w[12]!;
                data[o + 1] = w[13]!;
                data[o + 2] = w[14]!;
                data[o + 3] = 2;
                data[o + 4] = light.diffuse[0] * light.intensity;
                data[o + 5] = light.diffuse[1] * light.intensity;
                data[o + 6] = light.diffuse[2] * light.intensity;
                data[o + 7] = light.range;
                data[o + 8] = light.specular[0] * light.intensity;
                data[o + 9] = light.specular[1] * light.intensity;
                data[o + 10] = light.specular[2] * light.intensity;
                data[o + 11] = light.exponent;
                // Direction = worldMatrix column 2
                data[o + 12] = w[8]!;
                data[o + 13] = w[9]!;
                data[o + 14] = w[10]!;
                data[o + 15] = _cosHalfAngle;
            },
        },
        wm,
        lvs
    );

    // Push-based dirty tracking for angle — recompute cosHalfAngle on change
    Object.defineProperty(light, "angle", {
        get() {
            return _angle;
        },
        set(v: number) {
            if (v !== _angle) {
                _angle = v;
                _cosHalfAngle = Math.cos(v * 0.5);
                lvs.bump();
            }
        },
        configurable: true,
        enumerable: true,
    });

    return light;
}
