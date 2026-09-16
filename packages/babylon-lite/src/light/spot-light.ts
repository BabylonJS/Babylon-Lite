/** SpotLight — cone-shaped light with position, direction, angle, and exponent falloff.
 *  Plain data, no scene knowledge (pillar 4b).
 *  Push-based dirty tracking via ObservableVec3. */

import type { LightBase } from "./types.js";
import { ObservableVec3, createLightBase, applyLightBase, copyLightBase, writeWorldLightDirection } from "./light-base.js";

export interface SpotLight extends LightBase {
    readonly lightType: "spot";
    readonly position: ObservableVec3;
    readonly direction: ObservableVec3;
    /** Full cone angle in radians. */
    angle: number;
    /** Falloff exponent — higher = sharper spotlight. */
    exponent: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

/**
 * Creates a spot light: a cone of light from `position` aimed along `direction`.
 * @param position - World-space position of the light.
 * @param direction - World-space direction the cone points along.
 * @param angle - Full cone angle in radians.
 * @param exponent - Falloff exponent; higher values produce a sharper edge.
 * @param intensity - Scalar multiplier applied to the light's diffuse and specular contribution.
 * @returns Plain `SpotLight` data to be added to a scene via `addToScene`.
 */
export function createSpotLight(position: [number, number, number], direction: [number, number, number], angle: number, exponent: number, intensity = 1.0): SpotLight {
    const { node, lvs } = createLightBase(position);

    // Pre-compute cosHalfAngle; updated via Object.defineProperty when angle changes
    let _angle = angle;
    let _cosHalfAngle = Math.cos(angle * 0.5);

    const light = applyLightBase<SpotLight>(
        node,
        {
            lightType: "spot" as const,
            direction: new ObservableVec3(direction[0], direction[1], direction[2], lvs.b),
            angle: 0 as number, // placeholder — overridden by defineProperty below
            exponent,
            diffuse: [1, 1, 1] as [number, number, number],
            specular: [1, 1, 1] as [number, number, number],
            intensity,
            range: Number.MAX_VALUE,
            _cloneNode: () => {
                const clone = createSpotLight(
                    [light.position.x, light.position.y, light.position.z],
                    [light.direction.x, light.direction.y, light.direction.z],
                    light.angle,
                    light.exponent,
                    light.intensity
                );
                clone.diffuse = [...light.diffuse];
                clone.specular = [...light.specular];
                clone.range = light.range;
                copyLightBase(light, clone);
                return clone;
            },

            _writeLightUbo: (data: Float32Array, offset: number) => {
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
                // Direction = local direction transformed by world matrix
                writeWorldLightDirection(data, o + 12, w, light.direction);
                data[o + 15] = _cosHalfAngle;
            },
        },
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
                lvs.b();
            }
        },
        configurable: true,
        enumerable: true,
    });

    return light;
}
