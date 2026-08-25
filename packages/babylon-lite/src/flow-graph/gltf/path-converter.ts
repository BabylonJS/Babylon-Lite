// SPEC-VOLATILE — see object-model-mapping.ts. Mirrored against Khronos commit
// fdb8ce0e2e0b7ecf3466f8dacb9f1385257b8276 and Babylon.js commit
// bd3837eed0890e590fdd6aeb6cc4d605e4eb8ac7.
//
// path-converter: resolves a (literal-substituted) JSON pointer string such as
// "/nodes/0/translation" to an FgAccessor (get/set closures) over the addressed
// object. The KHR_interactivity loader feeds the glTF node map + runtime material
// map so accessors never hold a scene reference — they close over the resolved
// node/material only.
//
// DRY: material UV-transform and node-visibility WRITES delegate to the shared
// KHR_animation_pointer resolver (`resolveAnimationPointer`), which already owns
// the tricky per-texture isolation (so two materials sharing one atlas texture
// don't clobber each other) and the UBO/visibility-epoch invalidation. Pointer
// GETs read the runtime fields directly (the animation registry is write-only).
//
// LITE DIVERGENCE: BJS resolves pointers at RUNTIME via JsonPointerParser +
// gltfPathToObjectConverter. Lite pre-resolves them here at LOAD time, collapsing
// the JsonPointerParser/GetProperty/SetProperty trio into a single block reading
// a pre-resolved accessor. See blocks/data/{get,set}-property.ts.

import type { FgAccessor } from "../context.js";
import type { FgValue, Vec2 } from "../types.js";
import { FgType } from "../types.js";
import type { TransformNode } from "../../scene/transform-node.js";
import type { Quat, Vec3, Vec4 } from "../../math/types.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { AnimationGroup } from "../../animation/animation-group.js";
import { NODE_TRS_PROPS } from "./object-model-mapping.js";
import { resolveAnimationPointer, type PointerContext, type PointerMaterial } from "../../loader-gltf/animation-pointer.js";

/** Loader-supplied resolution context: the glTF node map plus the runtime
 *  material map (glTF material index → PBR material) and raw JSON for reuse of
 *  the KHR_animation_pointer writers. */
export interface PointerResolveContext {
    nodeMap: readonly (TransformNode | undefined)[];
    materials?: readonly (PointerMaterial | undefined)[];
    json?: object;
    scene?: SceneContext;
    animations?: readonly AnimationGroup[];
}

/** Build the PointerContext the animation-pointer registry expects. */
function animCtx(ctx: PointerResolveContext): PointerContext {
    return { nodes: ctx.nodeMap as PointerContext["nodes"], materials: ctx.materials, _json: ctx.json };
}

/** Parse `/nodes/{index}/{prop}` → `{ nodeIndex, prop }`, or `null` when the
 *  pointer is not a supported node-TRS path. */
function parseNodeTrsPointer(pointer: string): { nodeIndex: number; prop: string } | null {
    const m = /^\/nodes\/(\d+)\/(translation|rotation|scale)$/.exec(pointer);
    if (!m) {
        return null;
    }
    return { nodeIndex: Number(m[1]), prop: m[2]! };
}

const MAT_UV_RE =
    /^\/materials\/(\d+)\/(?:pbrMetallicRoughness\/baseColorTexture|emissiveTexture|normalTexture|occlusionTexture)\/extensions\/KHR_texture_transform\/(offset|scale)$/;
const VISIBILITY_RE = /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/;
const SELECTABILITY_RE = /^\/nodes\/(\d+)\/extensions\/KHR_node_selectability\/selectable$/;
const SUPPORTED_EXTENSIONS = new Set([
    "EXT_lights_image_based",
    "EXT_mesh_gpu_instancing",
    "EXT_meshopt_compression",
    "KHR_animation_pointer",
    "KHR_draco_mesh_compression",
    "KHR_gaussian_splatting",
    "KHR_interactivity",
    "KHR_lights_punctual",
    "KHR_materials_anisotropy",
    "KHR_materials_clearcoat",
    "KHR_materials_diffuse_transmission",
    "KHR_materials_dispersion",
    "KHR_materials_emissive_strength",
    "KHR_materials_ior",
    "KHR_materials_iridescence",
    "KHR_materials_pbrSpecularGlossiness",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_transmission",
    "KHR_materials_unlit",
    "KHR_materials_variants",
    "KHR_materials_volume",
    "KHR_mesh_quantization",
    "KHR_node_selectability",
    "KHR_node_visibility",
    "KHR_texture_basisu",
    "KHR_texture_transform",
    "KHR_xmp_json_ld",
]);

/** Resolve a literal-substituted JSON pointer to an `FgAccessor`, or `null` when
 *  it addresses an unsupported path or an unreachable node/material. */
export function resolvePointerAccessor(pointer: string, ctx: PointerResolveContext): FgAccessor | null {
    const trs = parseNodeTrsPointer(pointer);
    if (trs) {
        return resolveNodeTrs(trs.nodeIndex, trs.prop, ctx);
    }

    const uv = MAT_UV_RE.exec(pointer);
    if (uv) {
        return resolveMaterialUvTransform(pointer, Number(uv[1]), uv[2]!, ctx);
    }

    const vis = VISIBILITY_RE.exec(pointer);
    if (vis) {
        return resolveVisibility(pointer, Number(vis[1]), ctx);
    }

    const sel = SELECTABILITY_RE.exec(pointer);
    if (sel) {
        return resolveSelectability(Number(sel[1]), ctx);
    }

    const animation = /^\/animations\/(\d+)\/extensions\/KHR_interactivity\/(isPlaying|minTime|maxTime|playhead|virtualPlayhead)$/.exec(pointer);
    if (animation) {
        return resolveAnimationState(Number(animation[1]), animation[2]!, ctx);
    }

    if (/^\/extensions\/KHR_interactivity(?:\/[^/]+)?\/activeCamera\//.test(pointer)) {
        return resolveActiveCamera(pointer, ctx);
    }

    const limit = /^\/extensions\/KHR_interactivity\/limits\/(maxActiveAnimations|maxActiveDelays|maxActivePropertyInterpolations|maxActiveVariableInterpolations)$/.exec(pointer);
    if (limit) {
        return { type: FgType.Number, get: () => 2147483647 };
    }

    const version = /^\/extensions\/KHR_interactivity\/asset\/(majorVersion|minorVersion)$/.exec(pointer);
    if (version) {
        const [major = 2, minor = 0] = String((ctx.json as { asset?: { version?: string } } | undefined)?.asset?.version ?? "2.0")
            .split(".")
            .map(Number);
        return { type: FgType.Number, get: () => (version[1] === "majorVersion" ? Math.min(major, 2) : major < 2 ? minor : 0) };
    }

    const extensionEnabled = /^\/extensions\/KHR_interactivity\/asset\/extensions\/([^/]+)\/enabled$/.exec(pointer);
    if (extensionEnabled) {
        const used = (ctx.json as { extensionsUsed?: string[] } | undefined)?.extensionsUsed ?? [];
        return { type: FgType.Boolean, get: () => used.includes(extensionEnabled[1]!) && SUPPORTED_EXTENSIONS.has(extensionEnabled[1]!) };
    }

    return null;
}

function resolveAnimationState(index: number, property: string, ctx: PointerResolveContext): FgAccessor | null {
    const animation = ctx.animations?.[index];
    if (!animation) {
        return null;
    }
    return {
        type: property === "isPlaying" ? FgType.Boolean : FgType.Number,
        target: animation,
        get: () => {
            switch (property) {
                case "isPlaying":
                    return animation.isPlaying;
                case "minTime":
                    return 0;
                case "maxTime":
                    return animation.duration;
                default:
                    return animation.currentTime;
            }
        },
    };
}

function resolveActiveCamera(pointer: string, ctx: PointerResolveContext): FgAccessor | null {
    if (!ctx.scene) {
        return null;
    }
    const tail = pointer.substring(pointer.indexOf("/activeCamera/") + "/activeCamera/".length);
    const camera = () => ctx.scene!.camera;
    const perspective = () => {
        const value = camera();
        return value && !value.ortho ? value : null;
    };
    const orthographic = () => {
        const value = camera();
        return value?.ortho ? value : null;
    };
    const numeric = (get: () => number): FgAccessor => ({ type: FgType.Number, get });
    switch (tail) {
        case "position":
            return {
                type: FgType.Vector3,
                get: () => {
                    const value = camera();
                    return value ? { x: -value.worldMatrix[12]!, y: value.worldMatrix[13]!, z: value.worldMatrix[14]! } : { x: NaN, y: NaN, z: NaN };
                },
            };
        case "rotation":
            return {
                type: FgType.Quaternion,
                get: () => {
                    const value = camera();
                    if (!value) {
                        return { x: NaN, y: NaN, z: NaN, w: NaN };
                    }
                    const q = quatFromMatrix(value.worldMatrix);
                    return { x: -q.x, y: q.y, z: q.z, w: -q.w };
                },
            };
        case "perspective/aspectRatio":
            return numeric(() => {
                if (!perspective()) {
                    return NaN;
                }
                const surface = ctx.scene!.surface;
                const width = surface._w ?? surface.canvas.width;
                const height = surface._h ?? surface.canvas.height;
                return height ? width / height : NaN;
            });
        case "perspective/yfov":
            return numeric(() => perspective()?.fov ?? NaN);
        case "perspective/znear":
            return numeric(() => perspective()?.nearPlane ?? NaN);
        case "perspective/zfar":
            return numeric(() => perspective()?.farPlane ?? NaN);
        case "orthographic/xmag":
            return numeric(() => {
                const value = orthographic();
                if (!value?.ortho) {
                    return NaN;
                }
                const surface = ctx.scene!.surface;
                const aspect = (surface._w ?? surface.canvas.width) / (surface._h ?? surface.canvas.height);
                return ((value.ortho.right ?? value.ortho.halfHeight * aspect) - (value.ortho.left ?? -value.ortho.halfHeight * aspect)) / 2;
            });
        case "orthographic/ymag":
            return numeric(() => {
                const value = orthographic();
                return value?.ortho ? ((value.ortho.top ?? value.ortho.halfHeight) - (value.ortho.bottom ?? -value.ortho.halfHeight)) / 2 : NaN;
            });
        case "orthographic/znear":
            return numeric(() => orthographic()?.nearPlane ?? NaN);
        case "orthographic/zfar":
            return numeric(() => orthographic()?.farPlane ?? NaN);
        default:
            return null;
    }
}

function quatFromMatrix(matrix: ArrayLike<number>): Quat {
    const trace = matrix[0]! + matrix[5]! + matrix[10]!;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return { x: (matrix[6]! - matrix[9]!) / s, y: (matrix[8]! - matrix[2]!) / s, z: (matrix[1]! - matrix[4]!) / s, w: s / 4 };
    }
    if (matrix[0]! > matrix[5]! && matrix[0]! > matrix[10]!) {
        const s = Math.sqrt(1 + matrix[0]! - matrix[5]! - matrix[10]!) * 2;
        return { x: s / 4, y: (matrix[4]! + matrix[1]!) / s, z: (matrix[8]! + matrix[2]!) / s, w: (matrix[6]! - matrix[9]!) / s };
    }
    if (matrix[5]! > matrix[10]!) {
        const s = Math.sqrt(1 + matrix[5]! - matrix[0]! - matrix[10]!) * 2;
        return { x: (matrix[4]! + matrix[1]!) / s, y: s / 4, z: (matrix[9]! + matrix[6]!) / s, w: (matrix[8]! - matrix[2]!) / s };
    }
    const s = Math.sqrt(1 + matrix[10]! - matrix[0]! - matrix[5]!) * 2;
    return { x: (matrix[8]! + matrix[2]!) / s, y: (matrix[9]! + matrix[6]!) / s, z: s / 4, w: (matrix[1]! - matrix[4]!) / s };
}

function resolveNodeTrs(nodeIndex: number, prop: string, ctx: PointerResolveContext): FgAccessor | null {
    const node = ctx.nodeMap[nodeIndex];
    if (!node) {
        return null;
    }
    const entry = NODE_TRS_PROPS[prop]!;

    if (prop === "translation") {
        return {
            type: entry.type,
            target: node,
            get: () => ({ x: node.position.x, y: node.position.y, z: node.position.z }),
            set: (v) => {
                const p = toVec3(v);
                node.position.set(p.x, p.y, p.z);
            },
        };
    }
    if (prop === "scale") {
        return {
            type: entry.type,
            target: node,
            get: () => ({ x: node.scaling.x, y: node.scaling.y, z: node.scaling.z }),
            set: (v) => {
                const p = toVec3(v);
                node.scaling.set(p.x, p.y, p.z);
            },
        };
    }
    // rotation (quaternion)
    return {
        type: entry.type,
        target: node,
        get: () => ({ x: node.rotationQuaternion.x, y: node.rotationQuaternion.y, z: node.rotationQuaternion.z, w: node.rotationQuaternion.w }),
        set: (v) => {
            const q = toQuat(v);
            node.rotationQuaternion.set(q.x, q.y, q.z, q.w);
        },
    };
}

/** Material `KHR_texture_transform` offset/scale (Vec2). WRITES reuse the shared
 *  animation-pointer writer (per-texture isolation + UBO bump); READS sample the
 *  runtime baseColorTexture's UV fields directly. */
function resolveMaterialUvTransform(pointer: string, matIndex: number, kind: string, ctx: PointerResolveContext): FgAccessor | null {
    const mat = ctx.materials?.[matIndex];
    if (!mat) {
        return null;
    }
    const resolved = resolveAnimationPointer(pointer, animCtx(ctx));
    return {
        type: FgType.Vector2,
        target: mat,
        get: () => {
            const tex = mat.baseColorTexture;
            if (kind === "scale") {
                return { x: tex?.uScale ?? 1, y: tex?.vScale ?? 1 };
            }
            return { x: tex?.uOffset ?? 0, y: tex?.vOffset ?? 0 };
        },
        set: resolved
            ? (v) => {
                  const p = toVec2(v);
                  resolved.writer(Float32Array.of(p.x, p.y), 0);
              }
            : undefined,
    };
}

/** `KHR_node_visibility/visible` (boolean). WRITES reuse the shared
 *  animation-pointer writer (subtree cascade + visibility-epoch bump). */
function resolveVisibility(pointer: string, nodeIndex: number, ctx: PointerResolveContext): FgAccessor | null {
    const node = ctx.nodeMap[nodeIndex];
    if (!node) {
        return null;
    }
    const resolved = resolveAnimationPointer(pointer, animCtx(ctx));
    return {
        type: FgType.Boolean,
        target: node,
        get: () => node.visible !== false,
        set: resolved
            ? (v) => {
                  resolved.writer(Float32Array.of(v ? 1 : 0), 0);
              }
            : undefined,
    };
}

/** `KHR_node_selectability/selectable` (boolean). Lite has no picking gate, so
 *  this is a no-op accessor: the value round-trips but has no visual effect. */
function resolveSelectability(nodeIndex: number, ctx: PointerResolveContext): FgAccessor | null {
    const node = ctx.nodeMap[nodeIndex];
    if (!node) {
        return null;
    }
    let selectable = true;
    return {
        type: FgType.Boolean,
        target: node,
        get: () => selectable,
        set: (v) => {
            selectable = !!v;
        },
    };
}

function toVec2(v: FgValue): Vec2 {
    const o = (v ?? {}) as Partial<Vec2>;
    return { x: o.x ?? 0, y: o.y ?? 0 };
}

function toVec3(v: FgValue): Vec3 {
    const o = (v ?? {}) as Partial<Vec3 & Vec2>;
    return { x: o.x ?? 0, y: o.y ?? 0, z: (o as Vec3).z ?? 0 };
}

function toQuat(v: FgValue): Quat {
    const o = (v ?? {}) as Partial<Vec4>;
    return { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0, w: o.w ?? 1 };
}
