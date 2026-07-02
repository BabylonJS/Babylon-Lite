/** KHR_animation_pointer glTF feature.
 *
 *  Registered in the feature registry gated on `KHR_animation_pointer`, so any
 *  scene that doesn't declare the extension pays zero bytes for pointer
 *  resolution, the non-Float32 sampler converter, or the visibility cascade.
 *
 *  On side-effect import this module installs a pointer-channel parser into
 *  gltf-animation (resolves the JSON pointer to a writer fn) and pulls in the
 *  lazy sampler converter (`gltf-sampler-denorm`) that handles the
 *  non-Float32/misaligned accessor cases the fast path can't express (e.g. the
 *  11-byte UNSIGNED_BYTE visibility accessor in CubeVisibility.glb).
 *
 *  Node-visibility and node-TRS pointers resolve here directly. Material
 *  pointer targets (texture-transform offset/scale/rotation, factors, …) are
 *  resolved by `resolveAnimationPointer` in animation-pointer.ts, invoked from
 *  the pointer-channel parser installed below. */

import { installSamplerDenorm } from "./gltf-sampler-denorm.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { Mesh } from "../mesh/mesh.js";
import type { AnimationChannel, TargetPath } from "../animation/types.js";
import { PATH_POINTER, PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE, PATH_WEIGHTS } from "../animation/types.js";
import type { PointerMaterial } from "./animation-pointer.js";
import { resolveAnimationPointer } from "./animation-pointer.js";
import { _installPointerHandlers } from "./gltf-animation.js";

// Install the non-Float32 sampler converter (KHR_animation_pointer can drive normalized/misaligned
// accessors, e.g. CubeVisibility's 11-byte UNSIGNED_BYTE flags). Calling the imported binding keeps
// it alive through tree-shaking under the engine's `"sideEffects": false`.
installSamplerDenorm();

// Node TRS/weights pointer targets map 1:1 onto the standard glTF channel paths.
const NODE_TRS_PATH: Record<string, TargetPath> = {
    translation: PATH_TRANSLATION,
    rotation: PATH_ROTATION,
    scale: PATH_SCALE,
    weights: PATH_WEIGHTS,
};

// Material pointers (texture-transform) resolve against the runtime material indexed
// by glTF material index. Built from the same node→primitive→gpuMesh order the loader
// uploads in, and memoized per asset (one map per `meshes` array). `mesh.material` is
// the PbrMaterialProps carrying `_uboVersion` + the UV-transform texture slots.
let _matMapKey: readonly Mesh[] | null = null;
let _matMap: (PointerMaterial | undefined)[] = [];

// Punctual-light property pointers — writers live in animation-pointer-lights.ts.
const _LIGHT_POINTER_RE = /^\/extensions\/KHR_lights_punctual\/lights\/\d+\/(?:color|intensity|range|spot\/outerConeAngle)$/;
// Material factor / extension pointers — writers + load-time seeding live in
// animation-pointer-ext.ts.
const _MAT_EXT_POINTER_RE =
    /^\/materials\/\d+\/(?:pbrMetallicRoughness\/metallicFactor|normalTexture\/scale|occlusionTexture\/strength|extensions\/KHR_materials_(?:transmission|ior|volume|iridescence)\/)/;
// Animated baseColorFactor white-fallback pointer — handling lives in
// animation-pointer-basecolor.ts.
const _BASE_COLOR_POINTER_RE = /^\/materials\/\d+\/pbrMetallicRoughness\/baseColorFactor$/;

// Populated in preParse from the lazily-imported sub-modules, so materialMap + applyMaterial
// can delegate without re-importing. Each sub-module is fetched only when its pointer is
// present, so a node-only scene (scene34) loads none of them.
let _matExtMod: typeof import("./animation-pointer-ext.js") | null = null;
let _baseColorMod: typeof import("./animation-pointer-basecolor.js") | null = null;
function materialMap(json: any, meshes: readonly Mesh[]): (PointerMaterial | undefined)[] {
    if (meshes === _matMapKey) {
        return _matMap;
    }
    _matMapKey = meshes;
    const map: (PointerMaterial | undefined)[] = [];

    // Collect material indices targeted by a baseColorFactor pointer. Those materials
    // must carry a baseColorFactor UBO slot for the animation to have any effect, so
    // we seed `baseColorFactor` below — this runs at load (before the first render
    // computes material flags), forcing PBR2_HAS_BASE_COLOR_FACTOR on.
    const baseColorAnimated = new Set<number>();
    // Materials whose texture UV transform is animated. The loader only enables the
    // UV-transform machinery (PBR2_HAS_UV_TRANSFORM) when a texture carries a
    // *non-identity* static KHR_texture_transform. A material whose transform is
    // identity at load but animated at runtime (e.g. an occlusion rotation that
    // starts at 0) would otherwise compile without the per-texture UV matrices, so
    // the animation writes a transform the shader never samples. Force the flag for
    // these materials so the animation actually drives the UV.
    const uvTransformAnimated = new Set<number>();
    for (const anim of json.animations ?? []) {
        for (const ch of anim.channels ?? []) {
            const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
            const m = ptr && /^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/.exec(ptr);
            if (m) {
                baseColorAnimated.add(+m[1]!);
            }
            const tx = ptr && /^\/materials\/(\d+)\/.*\/KHR_texture_transform\/(offset|scale|rotation)$/.exec(ptr);
            if (tx) {
                uvTransformAnimated.add(+tx[1]!);
            }
        }
    }

    const nodes = json.nodes ?? [];
    let gpuIdx = 0;
    for (let ni = 0; ni < nodes.length; ni++) {
        const meshRef = nodes[ni]?.mesh;
        if (meshRef === undefined) {
            continue;
        }
        const prims = json.meshes?.[meshRef]?.primitives ?? [];
        for (let p = 0; p < prims.length; p++) {
            const matIdx = prims[p]?.material;
            const mesh = meshes[gpuIdx++];
            if (matIdx !== undefined && mesh) {
                const pm = mesh.material as unknown as PointerMaterial;
                const def = json.materials?.[matIdx];
                // Seed the separated emissive factor/strength from the asset so an
                // emissiveFactor or emissiveStrength pointer can recombine them
                // (emissiveColor is stored pre-multiplied at load).
                if (def && pm.emissiveColor) {
                    const ef = def.emissiveFactor ?? [0, 0, 0];
                    pm._animEmissiveFactor = [ef[0] ?? 0, ef[1] ?? 0, ef[2] ?? 0];
                    pm._animEmissiveStrength = def.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
                }
                // Force a baseColorFactor slot when a pointer animates it (the loader
                // omits it for untextured/default materials).
                if (baseColorAnimated.has(matIdx) && !pm.baseColorFactor) {
                    const bcf = def?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
                    pm.baseColorFactor = [bcf[0] ?? 1, bcf[1] ?? 1, bcf[2] ?? 1, bcf[3] ?? 1];
                }
                // Force the per-texture UV-transform machinery when a pointer animates a
                // texture transform that is identity at load (so the matrices exist for the
                // animation to drive — see uvTransformAnimated above).
                if (uvTransformAnimated.has(matIdx)) {
                    (pm as { _hasUvTx?: boolean })._hasUvTx = true;
                }
                map[matIdx] = pm;
            }
        }
    }
    // Material factor / extension seeding (transmission, IOR, volume, occlusion strength)
    // lives in the lazy module loaded by preParse only when such a pointer is present.
    _matExtMod?.seedExtMaterials(json, map);
    _matMap = map;
    return map;
}

_installPointerHandlers((ptr, c, nodeMap, json, meshes) => {
    if (!nodeMap) {
        return null;
    }
    // A /nodes/{n}/{translation|rotation|scale|weights} pointer is semantically
    // identical to a standard glTF channel on node n. Emit a standard channel so it
    // flows through the proven topological node-TRS / morph writeback (which moves the
    // node AND its descendants) instead of an opaque per-node writer.
    const trs = /^\/nodes\/(\d+)\/(translation|rotation|scale|weights)$/.exec(ptr);
    if (trs) {
        return { samplerIdx: c.sampler, nodeIdx: +trs[1]!, path: NODE_TRS_PATH[trs[2]!]! };
    }
    // Only build the material map when a non-node pointer is actually present.
    const resolved = resolveAnimationPointer(ptr, { nodes: nodeMap, materials: materialMap(json, meshes), _json: json });
    if (!resolved) {
        return null;
    }
    const ch: AnimationChannel = {
        samplerIdx: c.sampler,
        nodeIdx: -1,
        path: PATH_POINTER,
        pointerWriter: resolved.writer,
        pointerArity: resolved.arity,
    };
    return ch;
});

const feature: GltfFeature = {
    id: "KHR_animation_pointer",
    // Raw glTF material defs whose pbrMetallicRoughness/baseColorFactor is animated.
    // Collected here (where `json` is available) and consumed in applyMaterial (which
    // only receives the GltfMaterialData). Both hooks live in this lazy feature module,
    // so non-pointer scenes pay zero bytes for the white-fallback handling.
    async preParse(json: any) {
        let hasLightPointer = false;
        let hasMatExtPointer = false;
        let hasBaseColorPointer = false;
        for (const anim of json.animations ?? []) {
            for (const ch of anim.channels ?? []) {
                const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
                if (!ptr) {
                    continue;
                }
                if (_BASE_COLOR_POINTER_RE.test(ptr)) {
                    hasBaseColorPointer = true;
                }
                if (_LIGHT_POINTER_RE.test(ptr)) {
                    hasLightPointer = true;
                }
                if (_MAT_EXT_POINTER_RE.test(ptr)) {
                    hasMatExtPointer = true;
                }
            }
        }
        // Each pointer-writer set lives in its own module fetched only when its pointer is
        // present, so a scene that animates just node visibility (scene34) or only lights
        // (scene39) never loads the others — minimal bundle movement for the unused features.
        if (hasBaseColorPointer) {
            _baseColorMod = await import("./animation-pointer-basecolor.js");
            _baseColorMod.collectBaseColorDefs(json);
        }
        if (hasLightPointer) {
            await import("./animation-pointer-lights.js");
        }
        if (hasMatExtPointer) {
            _matExtMod = await import("./animation-pointer-ext.js");
        }
    },
    // Animated baseColorFactor on untextured materials needs a white 1×1 fallback so the
    // factor isn't double-applied; the logic lives in the lazy base-color module loaded above.
    async applyMaterial(mat) {
        return _baseColorMod?.whiteFallback(mat) ?? null;
    },
};
export default feature;
