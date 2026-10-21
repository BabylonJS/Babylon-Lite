/** Per-call state and internal contract types shared by every glTF export module. */

import type { EngineContext } from "../engine/engine.js";
import type { Material } from "../material/material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { createBufferBuilder } from "./export-buffers.js";
import type { BufferBuilder } from "./export-buffers.js";
import type { GltfAnimation, GltfAsset, GltfCamera, GltfImage, GltfJsonObject, GltfMaterial, GltfMesh, GltfNode, GltfTexture } from "./export-gltf-types.js";

/** @internal The glTF document under construction. Every array starts empty; assembly writes only
 *  the non-empty ones, in a fixed member order. */
export interface GltfDraft {
    readonly asset: GltfAsset;
    /** Document-level extension payloads (`KHR_lights_punctual`). */
    readonly extensions: GltfJsonObject;
    /** Root node indices of `scenes[0]`. */
    readonly sceneNodes: number[];
    readonly nodes: GltfNode[];
    readonly meshes: GltfMesh[];
    readonly materials: GltfMaterial[];
    readonly textures: GltfTexture[];
    readonly images: GltfImage[];
    readonly cameras: GltfCamera[];
    readonly animations: GltfAnimation[];
}

/** @internal Tight RGBA8 pixels of one texture's mip 0, row 0 first (storage order). */
export interface PixelData {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/** @internal Row order of an emitted image relative to texture storage. */
export type RowOrder = "storage" | "reversed";

/** @internal How a mesh's second UV set exports (see "UV states" in the architecture doc). */
export type UvState = "uv1" | "uv0" | "lost";

/** @internal A `KHR_texture_transform` payload in glTF terms. */
export interface SlotTransform {
    readonly offset: readonly [number, number];
    readonly scale: readonly [number, number];
    readonly rotation: number;
}

/** @internal Where and how one material slot samples its texture. */
export interface SlotMapping {
    readonly texCoord: 0 | 1;
    readonly transform?: SlotTransform;
    readonly rowOrder: RowOrder;
    /** Channels to invert (`v → 255 − v`) in the emitted image; Standard bump slots only. */
    readonly invert?: "r" | "rg";
}

/** @internal A texture slot recorded during capture. Resolution writes `owner[key]`, or leaves it
 *  unset when the texture's pixels are unreadable. */
export interface PendingSlot {
    /** The JSON object that receives the textureInfo: a material, `pbrMetallicRoughness`, or an extension object. */
    readonly owner: GltfJsonObject;
    /** Member name in `owner`, e.g. "baseColorTexture". */
    readonly key: string;
    /** glTF slot string used as the image `name`, e.g. "baseColorTexture" or "clearcoatTexture". */
    readonly slot: string;
    readonly texture: Texture2D;
    readonly mapping: SlotMapping;
    /** Extra textureInfo members (`scale` for normal textures, `strength` for occlusion). */
    readonly extra?: Readonly<Record<string, number>>;
    readonly materialName: string;
    /** Set by fold resolution when the slot's texture folded into factors instead (1×1 ORM). */
    cancelled?: boolean;
    /** Set at resolution: whether `owner[key]` was written. */
    resolved?: boolean;
}

/** @internal A 1×1 factor fold recorded during capture; the folded factors are written at resolution. */
export interface PendingFold {
    /** The `pbrMetallicRoughness` object that receives the folded factors. */
    readonly owner: GltfJsonObject;
    readonly kind: "baseColor" | "metallicRoughness";
    readonly texture: Texture2D;
    /** The props' own factors, multiplied into the texel: `[r, g, b, a]` for base color
     *  (alpha already includes the material alpha), `[metallic, roughness]` for ORM. */
    readonly factor: readonly number[];
    readonly materialName: string;
    /** 1×1 ORM only: the slots that export the texture as an image when it cannot fold (its R byte
     *  is not 255 while occlusion reads it). Resolution cancels them when the fold applies. */
    readonly fallbackSlots?: readonly PendingSlot[];
}

/** @internal Per-call state shared by every export module. Discarded when the call resolves. */
export interface ExportContext {
    readonly engine: EngineContext;
    readonly doc: GltfDraft;
    readonly buffers: BufferBuilder;
    /** Exported scene object (node, folded mesh, light, camera) → glTF node index. */
    readonly nodeIndex: Map<object, number>;
    /** Exported scene object → whether its glTF node holds converted (left-handed source) data
     *  (true) or pass-through right-handed data (false). Same keys as {@link ExportContext.nodeIndex}. */
    readonly nodeConvert: Map<object, boolean>;
    /** Source material (after `getMaterialSource`) → glTF material index, per mesh UV state. */
    readonly materialIndex: Map<Material, Map<UvState, number>>;
    /** GPUTexture → its mip-0 pixels in storage row order, read back once per call. Submitted
     *  during capture; resolves to null when the texture is unreadable. Never rejects: GPU
     *  failures are recorded in {@link ExportContext.readbackErrors}. */
    readonly pixelCache: Map<GPUTexture, Promise<PixelData | null>>;
    /** GPU readback failures, in submission order. */
    readonly readbackErrors: unknown[];
    /** Decode-blit resources, created on the first blit of the call. */
    blit?: BlitResources;
    /** GPUTexture → its settled pixels; filled by the settle step, read by resolution. */
    readonly resolvedPixels: Map<GPUTexture, PixelData | null>;
    /** Texture slots recorded during capture, resolved after readbacks settle. */
    readonly slots: PendingSlot[];
    /** 1×1 factor folds recorded during capture, resolved before the slots. */
    readonly folds: PendingFold[];
    /** Callbacks that need resolved factors or slots (unlit, spec-gloss); run in registration order
     *  after folds and slots resolve. */
    readonly afterResolve: (() => void)[];
    /** Content key (size, row order, channel ops, FNV-1a of the bytes) → glTF image indices with that key. */
    readonly imageIndex: Map<string, number[]>;
    /** glTF image index → its emitted RGBA bytes, kept until encoding. */
    readonly imagePixels: PixelData[];
    /** glTF image index → glTF texture index (one texture per image; samplers are out of scope). */
    readonly textureIndex: Map<number, number>;
    /** Typed-array identity → (conversion variant → accessor index). */
    readonly accessorIndex: Map<ArrayBufferView, Map<string, number>>;
    /** Primitive-list signature → glTF mesh index. */
    readonly meshIndex: Map<string, number>;
    readonly extensionsUsed: Set<string>;
    readonly extensionsRequired: Set<string>;
    /** Logs each distinct message once per call, as `[babylon-lite] glTF export: <message>`. */
    warn(message: string): void;
}

/** @internal Per-call GPU objects shared by every decode blit (see `export-images.ts`). */
export interface BlitResources {
    readonly layout: GPUBindGroupLayout;
    readonly module: GPUShaderModule;
    readonly pipelineLayout: GPUPipelineLayout;
    /** Target format → blit pipeline. */
    readonly pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
}

/** @internal One glTF material extension writer. Writers form a static ordered array in
 *  `export-materials.ts`. */
export interface MaterialExtensionWriter {
    /** glTF extension name, e.g. "KHR_materials_clearcoat". */
    readonly name: string;
    /** Runs during capture (synchronous). When the material carries this extension's state, the
     *  writer attaches its payload with {@link attachExtension} (which records the name in
     *  `ctx.extensionsUsed`) and captures any texture slots through `captureTextureSlot`. Values
     *  that depend on resolved factors are written from a `ctx.afterResolve` callback. */
    write(ctx: ExportContext, material: PbrMaterialProps, out: GltfMaterial, uvState: UvState): void;
}

/** @internal Create the per-call context. */
export function createExportContext(engine: EngineContext, generator: string): ExportContext {
    const logged = new Set<string>();
    return {
        engine,
        doc: {
            asset: { version: "2.0", generator },
            extensions: {},
            sceneNodes: [],
            nodes: [],
            meshes: [],
            materials: [],
            textures: [],
            images: [],
            cameras: [],
            animations: [],
        },
        buffers: createBufferBuilder(),
        nodeIndex: new Map(),
        nodeConvert: new Map(),
        materialIndex: new Map(),
        pixelCache: new Map(),
        readbackErrors: [],
        resolvedPixels: new Map(),
        slots: [],
        folds: [],
        afterResolve: [],
        imageIndex: new Map(),
        imagePixels: [],
        textureIndex: new Map(),
        accessorIndex: new Map(),
        meshIndex: new Map(),
        extensionsUsed: new Set(),
        extensionsRequired: new Set(),
        warn(message) {
            if (!logged.has(message)) {
                logged.add(message);
                console.warn(`[babylon-lite] glTF export: ${message}`);
            }
        },
    };
}

/** @internal Attach `payload` as `owner.extensions[name]` and record the extension as used. */
export function attachExtension(ctx: ExportContext, owner: { extensions?: GltfJsonObject }, name: string, payload: GltfJsonObject): void {
    (owner.extensions ??= {})[name] = payload;
    ctx.extensionsUsed.add(name);
}

/** @internal A JSON snapshot of user extras taken during capture, so later writes cannot reach the output.
 *  Values that are not JSON-serializable are dropped with a warning. */
export function snapshotExtras(ctx: ExportContext, extras: unknown, ownerName: string | undefined): unknown {
    if (extras === undefined) {
        return undefined;
    }
    try {
        const text = JSON.stringify(extras);
        return text === undefined ? undefined : JSON.parse(text);
    } catch {
        ctx.warn(`Extras of "${ownerName ?? ""}" are not JSON-serializable; exporting without them.`);
        return undefined;
    }
}
