/** KHR_animation_pointer — animated baseColorFactor slots and runtime targets.
 *
 *  Dynamic-imported by the animation-pointer feature ONLY when a channel targets a
 *  material's pbrMetallicRoughness/baseColorFactor, so scenes that animate just node
 *  visibility / TRS / lights / UV transforms (e.g. scene34) never pay for it. */
import type { GltfMaterialData } from "./gltf-material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { _writeBaseColorFactor } from "./animation-pointer.js";
import type { BaseColorPointerMaterial, ResolvedPointer } from "./animation-pointer.js";

// Runtime copies keyed by the raw glTF definition whose baseColorFactor is animated.
// Lazy-init (not a module-level allocation) so this module stays tree-shakable per GUIDANCE.
let _animBaseColorDefs: WeakMap<object, BaseColorPointerMaterial[]> | null = null;

/** Record each animated material definition before default and variant assembly start. */
export function collectBaseColorDefs(json: any): void {
    for (const anim of json.animations ?? []) {
        for (const ch of anim.channels ?? []) {
            const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
            const m = ptr && /^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/.exec(ptr);
            const def = m && json.materials?.[+m[1]!];
            if (def && !_animBaseColorDefs?.has(def)) {
                (_animBaseColorDefs ??= new WeakMap()).set(def, []);
            }
        }
    }
}

/** Seed every animated slot and register its built copy. Untextured materials need a
 *  white fallback so their RGB factor is applied only by the animated uniform. */
export function prepareMaterial(mat: GltfMaterialData): Partial<PbrMaterialProps> | null {
    const targets = _animBaseColorDefs?.get(mat._rawMatDef);
    if (!targets) {
        return null;
    }
    mat._onMaterialCreated = (material) => {
        targets.push(material);
    };
    const f = mat._baseColorFactor;
    if (!mat._baseColorImage) {
        mat._baseColorFactor = [1, 1, 1, 1];
    }
    return { baseColorFactor: [f[0]!, f[1]!, f[2]!, 1], ...(mat._alphaMode === "BLEND" || mat._alphaMode === "MASK" ? { alpha: f[3] } : undefined) };
}

export function resolveBaseColorPointer(ptr: string, json: any): ResolvedPointer | null {
    const match = /^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/.exec(ptr);
    const def = match && json.materials?.[+match[1]!];
    const targets = _animBaseColorDefs?.get(def);
    if (!targets) {
        return null;
    }
    // Variant-only targets can register after channels parse; retain the live group.
    return {
        arity: 4,
        writer: (out, off) => {
            for (const material of targets) {
                _writeBaseColorFactor(material, out, off);
            }
        },
    };
}
