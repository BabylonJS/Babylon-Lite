import type { LightBase } from "./types.js";
import { applyLightBase, copyLightBase, createLightBase } from "./light-base.js";
import type { SceneLightingExtension } from "./lighting-extension.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** A single-sided rectangular emitter, shining along its SceneNode's local -Z axis. */
export interface RectAreaLight extends LightBase {
    readonly lightType: "rectArea";
    /** Local width. World scaling is applied independently. */
    width: number;
    /** Local height. World scaling is applied independently. */
    height: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    /** Direct intensity multiplier, without photometric conversion. */
    intensity: number;
    /** Preprocessed emitter image, or null for solid emission. Changes require a scene lighting rebuild. */
    emissionTexture: Texture2D | null;
    /** @internal Specialized clone constructor consumed by cloneTransformNode. */
    _cloneNode?: () => RectAreaLight;
}

function validateSize(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`RectAreaLight: ${name} must be finite and nonnegative, got ${value}`);
    }
}

/** Create scene-free rectangular light data. Call `enableRectAreaLights(scene)` before registration. */
export function createRectAreaLight(position: [number, number, number], width: number, height: number, intensity = 1): RectAreaLight {
    validateSize(width, "width");
    validateSize(height, "height");
    validateSize(intensity, "intensity");
    const { node, lvs } = createLightBase(position);
    const light = applyLightBase<RectAreaLight>(
        node,
        {
            lightType: "rectArea",
            width,
            height,
            intensity,
            diffuse: [1, 1, 1],
            specular: [1, 1, 1],
            emissionTexture: null,
            _validateLighting: (extension: SceneLightingExtension | undefined) => {
                if (light.shadowGenerator) {
                    throw new Error("RectAreaLight: area-light shadows are not supported yet");
                }
                if (!extension?._single?.("rectArea")) {
                    throw new Error("RectAreaLight: await enableRectAreaLights(scene) before registering this scene");
                }
            },
            _cloneNode: () => {
                const clone = createRectAreaLight([light.position.x, light.position.y, light.position.z], light.width, light.height, light.intensity);
                clone.diffuse = [...light.diffuse];
                clone.specular = [...light.specular];
                clone.emissionTexture = light.emissionTexture;
                copyLightBase(light, clone);
                return clone;
            },
            _writeLightUbo: (data: Float32Array, o: number) => {
                const w = light.worldMatrix;
                const hw = light.width / 2;
                const hh = light.height / 2;
                data[o] = w[12]!;
                data[o + 1] = w[13]!;
                data[o + 2] = w[14]!;
                data[o + 3] = 4;
                data[o + 4] = light.diffuse[0] * light.intensity;
                data[o + 5] = light.diffuse[1] * light.intensity;
                data[o + 6] = light.diffuse[2] * light.intensity;
                data[o + 7] = w[0]! * hw;
                data[o + 8] = light.specular[0] * light.intensity;
                data[o + 9] = light.specular[1] * light.intensity;
                data[o + 10] = light.specular[2] * light.intensity;
                data[o + 11] = w[1]! * hw;
                data[o + 12] = w[2]! * hw;
                data[o + 13] = w[4]! * hh;
                data[o + 14] = w[5]! * hh;
                data[o + 15] = w[6]! * hh;
            },
        },
        lvs
    );
    for (const key of ["width", "height", "intensity"] as const) {
        let value = light[key];
        Object.defineProperty(light, key, {
            enumerable: true,
            get: () => value,
            set: (next: number) => {
                validateSize(next, key);
                if (value !== next) {
                    value = next;
                    lvs.b();
                }
            },
        });
    }
    for (const key of ["diffuse", "specular"] as const) {
        const track = (tuple: [number, number, number]): [number, number, number] =>
            new Proxy([...tuple], {
                set(target, property, value: unknown): boolean {
                    const previous: unknown = Reflect.get(target, property);
                    const changed = Reflect.set(target, property, value);
                    if (changed && previous !== value) {
                        lvs.b();
                    }
                    return changed;
                },
            });
        let value = track(light[key]);
        Object.defineProperty(light, key, {
            enumerable: true,
            get: () => value,
            set: (next: [number, number, number]) => {
                if (value !== next) {
                    value = track(next);
                    lvs.b();
                }
            },
        });
    }
    let emission: Texture2D | null = null;
    Object.defineProperty(light, "emissionTexture", {
        enumerable: true,
        get: () => emission,
        set: (next: Texture2D | null) => {
            if (next !== null && typeof next !== "object") {
                throw new Error("RectAreaLight: emissionTexture must be a Texture2D or null");
            }
            if (emission !== next) {
                emission = next;
                lvs.b();
            }
        },
    });
    return light;
}
