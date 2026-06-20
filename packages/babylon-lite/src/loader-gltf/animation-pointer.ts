/** KHR_animation_pointer — JSON-pointer resolver registry.
 *  Handlers are registered incrementally (one per parity scene). Unknown
 *  pointers return null and warn once. */
import type { SceneNode } from "../scene/scene-node.js";
import { setSubtreeVisible } from "../scene/visibility.js";

export interface ResolvedPointer {
    writer: (output: Float32Array, offset: number) => void;
    arity: number;
}

/** Minimal mutable view of a UV-transform texture slot the pointer writers drive.
 *  Mirrors the fields `material/pbr/fragments/uv-transform-fragment.ts` reads. */
export interface PointerUvTexture {
    uScale?: number;
    vScale?: number;
    uOffset?: number;
    vOffset?: number;
    /** KHR_texture_transform rotation (radians) — drives the UV matrix's rotation. */
    uAng?: number;
}

/** Minimal mutable view of a runtime material a pointer can animate. Bumping
 *  `_uboVersion` makes the renderable re-upload the material UBO next frame. */
export interface PointerMaterial {
    /** @internal */
    _uboVersion: number;
    baseColorTexture?: PointerUvTexture;
    emissiveTexture?: PointerUvTexture;
    normalTexture?: PointerUvTexture;
    ormTexture?: PointerUvTexture;
    specGlossTexture?: PointerUvTexture;
    /** Runtime emissive (linear RGB) = emissiveFactor × emissiveStrength. */
    emissiveColor?: [number, number, number];
    /** Runtime base-color factor (linear RGBA). */
    baseColorFactor?: [number, number, number, number];
    /** @internal Animated glTF emissiveFactor, kept separate so an emissiveStrength
     *  pointer can recombine without losing the factor (and vice-versa). */
    _animEmissiveFactor?: [number, number, number];
    /** @internal Animated KHR_materials_emissive_strength value. */
    _animEmissiveStrength?: number;
}

/** Recompute emissiveColor = factor × strength after either input animates, then
 *  flag the material UBO for re-upload. */
function applyEmissive(mat: PointerMaterial): void {
    if (!mat.emissiveColor) {
        return;
    }
    const f = mat._animEmissiveFactor ?? [0, 0, 0];
    const s = mat._animEmissiveStrength ?? 1;
    mat.emissiveColor[0] = f[0]! * s;
    mat.emissiveColor[1] = f[1]! * s;
    mat.emissiveColor[2] = f[2]! * s;
    mat._uboVersion++;
}

export interface PointerContext {
    nodes: readonly (SceneNode | undefined)[];
    /** Runtime materials indexed by glTF material index (built by the pointer feature). */
    materials?: readonly (PointerMaterial | undefined)[];
}

type PointerFactory = (match: RegExpExecArray, ctx: PointerContext) => ResolvedPointer | null;

// Maps a KHR_texture_transform pointer's texture-slot segment to the material field.
const TX_SLOT: Record<string, keyof PointerMaterial> = {
    "pbrMetallicRoughness/baseColorTexture": "baseColorTexture",
    emissiveTexture: "emissiveTexture",
    normalTexture: "normalTexture",
    occlusionTexture: "ormTexture",
    "pbrMetallicRoughness/metallicRoughnessTexture": "ormTexture",
};

const _registry: [RegExp, PointerFactory][] = [
    // /nodes/{n}/extensions/KHR_node_visibility/visible — scalar (0 = hidden).
    // The setter cascade handles descendants per the KHR_node_visibility spec
    // and bumps the module-scoped visibility epoch so the engine invalidates
    // its cached render bundle.
    [
        /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/,
        (m, ctx) => {
            const n = ctx.nodes[+m[1]!];
            if (!n) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    setSubtreeVisible(n, out[off]! !== 0);
                },
            };
        },
    ],
    // /materials/{m}/.../KHR_texture_transform/{offset|scale|rotation} — animated UV
    // transform. offset/scale are vec2; rotation is a scalar (radians). Mutates the
    // slot texture's uOffset/vOffset, uScale/vScale, or uAng and bumps the material's
    // UBO version so the renderable re-uploads the UV matrix.
    [
        /^\/materials\/(\d+)\/(pbrMetallicRoughness\/baseColorTexture|pbrMetallicRoughness\/metallicRoughnessTexture|emissiveTexture|normalTexture|occlusionTexture)\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            const tex = mat?.[TX_SLOT[m[2]!]!] as PointerUvTexture | undefined;
            if (!mat || !tex) {
                return null;
            }
            const kind = m[3];
            if (kind === "rotation") {
                return {
                    arity: 1,
                    writer: (out, off) => {
                        tex.uAng = out[off]!;
                        mat._uboVersion++;
                    },
                };
            }
            const isScale = kind === "scale";
            return {
                arity: 2,
                writer: (out, off) => {
                    if (isScale) {
                        tex.uScale = out[off]!;
                        tex.vScale = out[off + 1]!;
                    } else {
                        tex.uOffset = out[off]!;
                        tex.vOffset = out[off + 1]!;
                    }
                    mat._uboVersion++;
                },
            };
        },
    ],
    // /materials/{m}/emissiveFactor — vec3. Recombined with emissiveStrength into
    // the runtime emissiveColor. Requires the material to carry an emissive slot
    // (non-zero load-time emissiveFactor) so the UBO field exists.
    [
        /^\/materials\/(\d+)\/emissiveFactor$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat?.emissiveColor) {
                return null;
            }
            return {
                arity: 3,
                writer: (out, off) => {
                    mat._animEmissiveFactor = [out[off]!, out[off + 1]!, out[off + 2]!];
                    applyEmissive(mat);
                },
            };
        },
    ],
    // /materials/{m}/extensions/KHR_materials_emissive_strength/emissiveStrength —
    // scalar HDR multiplier on emissiveFactor.
    [
        /^\/materials\/(\d+)\/extensions\/KHR_materials_emissive_strength\/emissiveStrength$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat?.emissiveColor) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat._animEmissiveStrength = out[off]!;
                    applyEmissive(mat);
                },
            };
        },
    ],
    // /materials/{m}/pbrMetallicRoughness/baseColorFactor — vec4 linear RGBA factor.
    // Only animatable when the material already carries a baseColorFactor UBO slot.
    [
        /^\/materials\/(\d+)\/pbrMetallicRoughness\/baseColorFactor$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat?.baseColorFactor) {
                return null;
            }
            return {
                arity: 4,
                writer: (out, off) => {
                    mat.baseColorFactor![0] = out[off]!;
                    mat.baseColorFactor![1] = out[off + 1]!;
                    mat.baseColorFactor![2] = out[off + 2]!;
                    mat.baseColorFactor![3] = out[off + 3]!;
                    mat._uboVersion++;
                },
            };
        },
    ],
];

const _warned = new Set<string>();

export function resolveAnimationPointer(pointer: string, ctx: PointerContext): ResolvedPointer | null {
    for (const [rx, make] of _registry) {
        const m = rx.exec(pointer);
        if (m) {
            return make(m, ctx);
        }
    }
    if (!_warned.has(pointer)) {
        _warned.add(pointer);

        console.warn(`[babylon-lite] KHR_animation_pointer: no handler for "${pointer}"`);
    }
    return null;
}
