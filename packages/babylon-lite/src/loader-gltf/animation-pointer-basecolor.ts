/** KHR_animation_pointer — animated baseColorFactor white-fallback handling.
 *
 *  Dynamic-imported by the animation-pointer feature ONLY when a channel targets a
 *  material's pbrMetallicRoughness/baseColorFactor, so scenes that animate just node
 *  visibility / TRS / lights / UV transforms (e.g. scene34) never pay for it. */
import type { GltfMaterialData } from "./gltf-material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";

// Raw glTF material defs (json.materials[i] objects) whose baseColorFactor is animated.
// Lazy-init (not a module-level allocation) so this module stays tree-shakable per GUIDANCE.
let _animBaseColorDefs: WeakSet<object> | null = null;

/** Record every material def targeted by a baseColorFactor pointer so the white-fallback
 *  below can recognise it during material assembly. */
export function collectBaseColorDefs(json: any): void {
    for (const anim of json.animations ?? []) {
        for (const ch of anim.channels ?? []) {
            const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
            const m = ptr && /^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/.exec(ptr);
            const def = m && json.materials?.[+m[1]!];
            if (def) {
                (_animBaseColorDefs ??= new WeakSet<object>()).add(def);
            }
        }
    }
}

/** For an UNTEXTURED material whose baseColorFactor is animated, the loader would bake the
 *  (initial) factor into the 1×1 base-colour fallback AND multiply the animated factor in
 *  the shader — doubling colour and alpha. Bake a WHITE fallback instead and route the
 *  factor through the (animatable) baseColorFactor uniform. */
export function whiteFallback(mat: GltfMaterialData): Partial<PbrMaterialProps> | null {
    if (mat._rawMatDef && _animBaseColorDefs?.has(mat._rawMatDef) && !mat._baseColorImage) {
        const f = mat._baseColorFactor;
        const real: [number, number, number, number] = [f[0]!, f[1]!, f[2]!, f[3]!];
        mat._baseColorFactor = [1, 1, 1, 1];
        return { baseColorFactor: real };
    }
    return null;
}
