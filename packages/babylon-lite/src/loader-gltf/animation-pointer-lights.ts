/** KHR_animation_pointer — punctual-light pointer handler.
 *
 *  Dynamic-imported by the animation-pointer feature ONLY when a channel targets a
 *  KHR_lights_punctual light property, so scenes that don't animate lights never pay
 *  for it. On import it appends its handler to the shared resolver registry. */
import type { LightBase } from "../light/types.js";
import { getGltfPunctualLight } from "./gltf-light-pointer-state.js";
import { _appendPointerHandlers, type PointerFactory } from "./animation-pointer.js";

const _lightHandlers: [RegExp, PointerFactory][] = [
    // /extensions/KHR_lights_punctual/lights/{l}/{color|intensity|range|spot/outerConeAngle}
    [
        /^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/(color|intensity|range|spot\/outerConeAngle)$/,
        (m, ctx) => {
            const lightIdx = +m[1]!;
            const field = m[2]!;
            const getLight = ():
                | (LightBase & {
                      diffuse?: [number, number, number];
                      specular?: [number, number, number];
                      intensity?: number;
                      range?: number;
                      angle?: number;
                  })
                | null => {
                return (getGltfPunctualLight(ctx._json, lightIdx) as ReturnType<typeof getLight>) ?? null;
            };
            return {
                arity: field === "color" ? 3 : 1,
                writer: (out, off) => {
                    const light = getLight();
                    if (!light) {
                        return;
                    }
                    if (field === "color") {
                        // Mutate the existing diffuse/specular arrays in place — pointer
                        // writers can run every frame, so avoid allocating a tuple per keyframe.
                        // The UBO refresh is driven by `_bumpLightVersion()` below, not the assignment.
                        if (light.diffuse) {
                            light.diffuse[0] = out[off]!;
                            light.diffuse[1] = out[off + 1]!;
                            light.diffuse[2] = out[off + 2]!;
                        }
                        if (light.specular) {
                            light.specular[0] = out[off]!;
                            light.specular[1] = out[off + 1]!;
                            light.specular[2] = out[off + 2]!;
                        }
                    } else if (field === "intensity") {
                        light.intensity = out[off]!;
                    } else if (field === "range") {
                        light.range = out[off]!;
                    } else if (light.lightType === "spot") {
                        light.angle = out[off]! * 2;
                    }
                    light._bumpLightVersion?.();
                },
            };
        },
    ],
];

_appendPointerHandlers(_lightHandlers);
