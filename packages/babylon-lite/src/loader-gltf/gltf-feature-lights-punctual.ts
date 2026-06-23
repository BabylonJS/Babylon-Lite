/** KHR_lights_punctual glTF extension.
 *  Parses point / directional / spot lights from the asset's top-level
 *  KHR_lights_punctual.lights array and instantiates one Lite light per
 *  referencing node, baking the node's world transform into the light's
 *  position / direction. Lights are contributed via the AssetContainer's
 *  `entities` array; addToScene() picks them up through the `lightType`
 *  branch of its traversal. */

import type { GltfFeature } from "./gltf-feature.js";
import type { LightBase } from "../light/types.js";
import { MAX_LIGHTS, setMaxLights } from "../light/types.js";
import { computeNodeWorldMatrix } from "./gltf-parser.js";
import { setGltfPunctualLight } from "./gltf-light-pointer-state.js";

interface GltfLightDef {
    type: "point" | "directional" | "spot";
    color?: [number, number, number];
    intensity?: number;
    range?: number;
    spot?: { innerConeAngle?: number; outerConeAngle?: number };
}

/** Fold the light's `worldMatrixVersion` (ancestor / animated-node motion) and a bump
 *  counter into its `_lightVersion`. The shared lights-UBO refresh (computeLightsVersion
 *  sums `_lightVersion`) then picks up an animated light NODE (KHR_animation_pointer node
 *  TRS) and direct color/intensity/range pointer writes — with NO change to the core light
 *  or lights-UBO code. All cost lives in this lazy KHR_lights_punctual feature, so scenes
 *  without punctual lights stay byte-identical. Harmless for static lights (constant offset). */
function bindAnimatedLightVersion(light: LightBase & { worldMatrixVersion?: number }): void {
    const baseGet = Object.getOwnPropertyDescriptor(light, "_lightVersion")?.get;
    let extra = 0;
    Object.defineProperty(light, "_lightVersion", {
        get(): number {
            return (baseGet ? (baseGet.call(light) as number) : 0) + (light.worldMatrixVersion ?? 0) + extra;
        },
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(light, "_bumpLightVersion", {
        value: () => {
            extra++;
        },
        enumerable: false,
        configurable: true,
    });
}

const feature: GltfFeature = {
    id: "KHR_lights_punctual",
    async applyAsset(_meshes, _root, ctx) {
        const defs: GltfLightDef[] | undefined = ctx._json.extensions?.KHR_lights_punctual?.lights;
        if (!defs?.length) {
            return {};
        }
        const lights: LightBase[] = [];
        const nodes = ctx._json.nodes ?? [];
        // Count lights first so we can raise MAX_LIGHTS before any pipeline is
        // compiled (loadGltf runs before addToScene which triggers pipeline
        // creation). Lite's MAX_LIGHTS is scene-wide, so cover every punctual
        // light declared by the asset rather than Babylon's per-material cap.
        let lightNodeCount = 0;
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i]?.extensions?.KHR_lights_punctual?.light !== undefined) {
                lightNodeCount++;
            }
        }
        if (lightNodeCount > MAX_LIGHTS) {
            setMaxLights(lightNodeCount);
        }
        for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
            const lightIdx: number | undefined = nodes[nodeIdx]?.extensions?.KHR_lights_punctual?.light;
            if (lightIdx === undefined) {
                continue;
            }
            const def = defs[lightIdx];
            if (!def) {
                continue;
            }
            // Prefer parenting the light to its source SceneNode so that an animated
            // light node (KHR_animation_pointer / node TRS channels) drives the light's
            // world position + direction every frame. The light then carries only its
            // glTF-local transform (origin, forward = -Z) and inherits the node's world
            // matrix via the shared parent chain. Falls back to baking the world
            // transform when the node is unreachable (no SceneNode), which keeps the
            // exact previous behaviour for assets without a node hierarchy.
            const sourceNode = ctx._nodeMap?.[nodeIdx];
            let px: number, py: number, pz: number;
            let dir: [number, number, number];
            if (sourceNode) {
                // Local: at node origin, forward = -Z. World = nodeWorld · local.
                px = py = pz = 0;
                dir = [0, 0, -1];
            } else {
                const world = computeNodeWorldMatrix(ctx._json, nodeIdx, ctx._parentMap, ctx._worldMatrixCache);
                px = world[12]!;
                py = world[13]!;
                pz = world[14]!;
                // glTF convention: light forward is -Z in local space. Extract world-space forward
                // by transforming (0,0,-1) through the node's upper-3x3. Normalize defensively.
                const fx = -world[8]!;
                const fy = -world[9]!;
                const fz = -world[10]!;
                const flen = Math.hypot(fx, fy, fz) || 1;
                dir = [fx / flen, fy / flen, fz / flen];
            }
            const color: [number, number, number] = def.color ? [def.color[0]!, def.color[1]!, def.color[2]!] : [1, 1, 1];
            const intensity = def.intensity ?? 1;
            const range = def.range !== undefined ? def.range : Number.MAX_VALUE;

            if (def.type === "point") {
                const { createPointLight } = await import("../light/point-light.js");
                const pl = createPointLight([px, py, pz], intensity);
                pl.diffuse = color;
                pl.specular = color;
                pl.range = range;
                if (sourceNode) {
                    pl.parent = sourceNode;
                }
                bindAnimatedLightVersion(pl);
                lights.push(pl);
                setGltfPunctualLight(ctx._json, lightIdx, pl);
            } else if (def.type === "directional") {
                const { createDirectionalLight } = await import("../light/directional-light.js");
                const dl = createDirectionalLight(dir, intensity);
                dl.diffuse = color;
                dl.specular = color;
                if (sourceNode) {
                    dl.parent = sourceNode;
                }
                bindAnimatedLightVersion(dl);
                lights.push(dl);
                setGltfPunctualLight(ctx._json, lightIdx, dl);
            } else if (def.type === "spot") {
                const { createSpotLight } = await import("../light/spot-light.js");
                const outer = def.spot?.outerConeAngle ?? Math.PI / 4;
                const sl = createSpotLight([px, py, pz], dir, outer * 2, 1, intensity);
                sl.diffuse = color;
                sl.specular = color;
                sl.range = range;
                if (sourceNode) {
                    sl.parent = sourceNode;
                }
                bindAnimatedLightVersion(sl);
                lights.push(sl);
                setGltfPunctualLight(ctx._json, lightIdx, sl);
            }
        }
        return { entities: lights };
    },
};
export default feature;
