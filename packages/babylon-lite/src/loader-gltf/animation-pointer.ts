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
    /** Independent-occlusion UV carrier (orm-unpack); present only when occlusion
     *  is sampled from the ORM texture with its own transform. */
    occlusionTexture?: PointerUvTexture;
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
// NOTE: metallicRoughnessTexture is intentionally absent. Babylon.js has a long-standing
// loader bug — its KHR_animation_pointer registration for the MR texture transform omits the
// `/extensions/KHR_texture_transform/` path segment (and adds a stray leading slash), so the
// interpolation is never attached and BJS silently skips animating the MR texture transform
// (offset/scale/rotation stay frozen at their static load-time values). We match BJS for parity
// (verified: animating MR regresses scene241 col1 MR rows by ~4.9 MAD vs the immutable golden,
// which renders these spheres with static roughness/metallic). Do NOT animate the MR transform.
const TX_SLOT: Record<string, keyof PointerMaterial> = {
    "pbrMetallicRoughness/baseColorTexture": "baseColorTexture",
    emissiveTexture: "emissiveTexture",
    normalTexture: "normalTexture",
    occlusionTexture: "ormTexture",
};

/** Resolve a glTF material-extension texture slot to the runtime PBR material's
 *  mutable texture object, so a KHR_texture_transform pointer on an extension
 *  texture can drive its UV transform. Only slots whose fragment actually applies
 *  the per-texture UV transform are listed (others would animate a value the
 *  shader ignores). */
function resolveExtTexture(mat: PointerMaterial, ext: string, field: string): PointerUvTexture | undefined {
    const m = mat as unknown as {
        iridescence?: Record<string, unknown>;
        sheen?: Record<string, unknown>;
        clearCoat?: Record<string, unknown>;
        anisotropy?: Record<string, unknown>;
        reflectanceTexture?: PointerUvTexture;
        metallicReflectanceTexture?: PointerUvTexture;
        subsurface?: { translucency?: Record<string, unknown>; refraction?: Record<string, unknown>; thickness?: Record<string, unknown> };
    };
    switch (`${ext}/${field}`) {
        case "KHR_materials_iridescence/iridescenceTexture":
            return privateTexture(m.iridescence, "texture");
        case "KHR_materials_iridescence/iridescenceThicknessTexture":
            return privateTexture(m.iridescence, "thicknessTexture");
        case "KHR_materials_anisotropy/anisotropyTexture":
            return privateTexture(m.anisotropy, "texture");
        case "KHR_materials_sheen/sheenColorTexture":
            return privateTexture(m.sheen, "texture");
        case "KHR_materials_sheen/sheenRoughnessTexture":
            // Drive the separate roughness texture when present; otherwise roughness shares
            // the colour texture (.a), so fall back to animating that single sheen texture.
            return privateTexture(m.sheen, (m.sheen as { roughnessTexture?: unknown })?.roughnessTexture ? "roughnessTexture" : "texture");
        case "KHR_materials_clearcoat/clearcoatTexture":
            return privateTexture(m.clearCoat, "texture");
        case "KHR_materials_clearcoat/clearcoatRoughnessTexture":
            return privateTexture(m.clearCoat, "roughnessTexture");
        case "KHR_materials_clearcoat/clearcoatNormalTexture":
            return privateTexture(m.clearCoat, "bumpTexture");
        case "KHR_materials_specular/specularTexture":
            return privateTexture(m as unknown as Record<string, unknown>, "metallicReflectanceTexture");
        case "KHR_materials_specular/specularColorTexture":
            return privateTexture(m as unknown as Record<string, unknown>, "reflectanceTexture");
        case "KHR_materials_diffuse_transmission/diffuseTransmissionColorTexture":
            return privateTexture(m.subsurface?.translucency, "colorTexture");
        case "KHR_materials_diffuse_transmission/diffuseTransmissionTexture":
            return privateTexture(m.subsurface?.translucency, "intensityTexture");
        case "KHR_materials_transmission/transmissionTexture":
            return privateTexture(m.subsurface?.refraction, "texture");
        case "KHR_materials_volume/thicknessTexture":
            return privateTexture(m.subsurface?.thickness, "texture");
        default:
            return undefined;
    }
}

/** Make a material's animated texture wrapper a private copy so that mutating its
 *  per-texture UV-transform fields (uOffset/uScale/uAng…) never leaks into other
 *  materials that share the same cached GPU texture wrapper. This happens when one
 *  image (e.g. a packed ORM/occlusion texture, or a sheen texture) is reused across
 *  several materials and only some of them animate its KHR_texture_transform — the
 *  shared wrapper would otherwise be mutated for all of them. The clone shares GPU
 *  resources (texture/view/sampler) via object spread; only the transform fields
 *  become independent. Idempotent via `_animPriv` so multiple channels
 *  (offset/scale/rotation) on the same slot reuse one private wrapper.
 *  @param parent - The object holding the texture slot (the material, or an extension
 *  sub-object such as `material.sheen`).
 *  @param key - The slot field name on `parent`. */
function privateTexture(parent: Record<string, unknown> | undefined, key: string): PointerUvTexture | undefined {
    const cur = parent?.[key] as (PointerUvTexture & { _animPriv?: true }) | undefined;
    if (!cur) {
        return undefined;
    }
    if (cur._animPriv) {
        return cur;
    }
    const clone = { ...(cur as object), _animPriv: true } as PointerUvTexture & { _animPriv: true };
    parent![key] = clone;
    return clone;
}

/** Build an offset/scale/rotation UV-transform writer for a resolved texture. */
function uvTransformWriter(mat: PointerMaterial, tex: PointerUvTexture, kind: string | undefined): ResolvedPointer {
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
}

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
        /^\/materials\/(\d+)\/(pbrMetallicRoughness\/baseColorTexture|emissiveTexture|normalTexture|occlusionTexture)\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat) {
                return null;
            }
            const slot = m[2]!;
            // orm-unpack: when occlusion has its own UV carrier (independent transform), drive
            // that; otherwise occlusion shares the single ORM transform (TX_SLOT fallback).
            const field: keyof PointerMaterial = slot === "occlusionTexture" && mat.occlusionTexture ? "occlusionTexture" : TX_SLOT[slot]!;
            // Isolate the animated slot so mutating its UV transform can't leak into other
            // materials that share the same cached texture wrapper (e.g. a reused ORM image).
            const tex = privateTexture(mat as unknown as Record<string, unknown>, field as string);
            if (!tex) {
                return null;
            }
            return uvTransformWriter(mat, tex, m[3]);
        },
    ],
    // /materials/{m}/extensions/{KHR_materials_*}/{slot}Texture/.../KHR_texture_transform/{offset|scale|rotation}
    // — animated UV transform on a material-extension texture (iridescence, sheen,
    // diffuse transmission). Resolves the runtime extension texture and drives its
    // UV transform exactly like the core slots.
    [
        /^\/materials\/(\d+)\/extensions\/(KHR_materials_\w+)\/(\w+Texture)\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            const tex = mat && resolveExtTexture(mat, m[2]!, m[3]!);
            if (!mat || !tex) {
                return null;
            }
            return uvTransformWriter(mat, tex, m[4]);
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
