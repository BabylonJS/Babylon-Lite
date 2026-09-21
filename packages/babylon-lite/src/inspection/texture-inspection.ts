import type {
    AppliedMaterialMutationClass,
    InspectionDatum,
    InspectionValue,
    MaterialInspectionMutationResult,
    MaterialInspectionMutationScope,
    TextureInspection,
    TextureInspectionKind,
    TextureInspectionOrigin,
    TextureInspectionTransform,
    TextureSampleCategory,
} from "./inspection-types.js";
import { getMaterialTextureBindings, inspectMaterial, _validateInspectionScopeScenes } from "./material-inspection.js";
import { enableMaterialUvTransform } from "../material/enable-material-uv-transform.js";
import { markMaterialUboDirty } from "../material/material-dirty.js";
import { rebuildMaterial } from "../material/material-rebuild.js";
import type { Material } from "../material/material.js";
import { _getTextureReferenceCount } from "../resource/texture-reference-store.js";
import type { SceneContext } from "../scene/scene-core.js";
import { TU } from "../engine/gpu-flags.js";
import type { Texture2D, Texture2DRecoverySource } from "../texture/texture-2d.js";

const unavailableReason = "This texture does not retain that metadata.";
const unsupportedReason = "This texture kind does not support that capability.";

interface TextureShape {
    readonly kind: TextureInspectionKind;
    readonly wrapper: Record<string, unknown>;
    readonly gpuTexture: Record<string, unknown> | undefined;
    readonly width: number;
    readonly height: number;
    readonly depthOrLayers: number;
}

interface RetainedSampler {
    readonly addressModeU?: unknown;
    readonly addressModeV?: unknown;
    readonly addressModeW?: unknown;
    readonly magFilter?: unknown;
    readonly minFilter?: unknown;
    readonly mipmapFilter?: unknown;
    readonly maxAnisotropy?: unknown;
}

interface TextureConsumer {
    readonly source: Material;
    readonly family: "standard" | "pbr";
    readonly scenes: SceneContext[];
    mutation: AppliedMaterialMutationClass;
}

function known<T>(value: T): InspectionDatum<T> {
    return { state: "known", value };
}

function unknown<T>(): InspectionDatum<T> {
    return { state: "unknown", reason: unavailableReason };
}

function present<T>(value: T): InspectionValue<T> {
    return { state: "present", value };
}

function unsupported<T>(): InspectionValue<T> {
    return { state: "unsupported", reason: unsupportedReason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function finiteDimension(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function detectTextureShape(texture: unknown): TextureShape | undefined {
    if (!isRecord(texture)) {
        return undefined;
    }
    try {
        if ("_texture" in texture && "_view" in texture && "_sampler" in texture) {
            const gpuTexture = isRecord(texture._texture) ? texture._texture : undefined;
            return {
                kind: "cube",
                wrapper: texture,
                gpuTexture,
                width: finiteDimension(gpuTexture?.width) ?? 0,
                height: finiteDimension(gpuTexture?.height) ?? 0,
                depthOrLayers: 6,
            };
        }
        if (!("texture" in texture) || !("view" in texture) || !("sampler" in texture)) {
            return undefined;
        }
        const width = finiteDimension(texture.width);
        const height = finiteDimension(texture.height);
        if (width === undefined || height === undefined) {
            return undefined;
        }
        const gpuTexture = isRecord(texture.texture) ? texture.texture : undefined;
        if ("layers" in texture) {
            const layers = finiteDimension(texture.layers);
            return layers === undefined ? undefined : { kind: "2d-array", wrapper: texture, gpuTexture, width, height, depthOrLayers: layers };
        }
        if ("depth" in texture) {
            const depth = finiteDimension(texture.depth);
            return depth === undefined ? undefined : { kind: "3d", wrapper: texture, gpuTexture, width, height, depthOrLayers: depth };
        }
        return { kind: "2d", wrapper: texture, gpuTexture, width, height, depthOrLayers: 1 };
    } catch {
        return undefined;
    }
}

function stringDatum(value: unknown): InspectionDatum<string> {
    return typeof value === "string" && value.length > 0 ? known(value) : unknown();
}

function numberDatum(value: unknown, minimum: number): InspectionDatum<number> {
    return typeof value === "number" && Number.isInteger(value) && value >= minimum ? known(value) : unknown();
}

function readOrigin(shape: TextureShape): InspectionDatum<TextureInspectionOrigin> {
    try {
        if (shape.kind === "2d" && "_readyState" in shape.wrapper && "_element" in shape.wrapper) {
            return known("html");
        }
        if (shape.wrapper._sampleType === "depth") {
            return known("sampled-depth");
        }
        const source = shape.wrapper._recoverySource as Texture2DRecoverySource | undefined;
        switch (source?.kind) {
            case "url":
                return known("url-raster");
            case "solid":
                return known("solid");
            case "pixels":
                return known("pixels");
            case "external":
            case "bitmap":
                return known("external-image");
            case "render":
                return known("render-target");
            case "dynamic":
                return known("dynamic");
            default:
                return known("unknown");
        }
    } catch {
        return known("unknown");
    }
}

function readFormat(shape: TextureShape): InspectionDatum<string> {
    try {
        return stringDatum(shape.gpuTexture?.format);
    } catch {
        return unknown();
    }
}

function readSampleCategory(shape: TextureShape, format: InspectionDatum<string>): InspectionDatum<TextureSampleCategory> {
    try {
        if (shape.wrapper._sampleType === "depth") {
            return known("depth");
        }
        if (format.state === "known") {
            const value = format.value;
            if (value.startsWith("depth") || value === "stencil8") {
                return known("depth");
            }
            if (value.endsWith("sint")) {
                return known("sint");
            }
            if (value.endsWith("uint")) {
                return known("uint");
            }
            if (value === "r32float" || value === "rg32float" || value === "rgba32float") {
                return known("unfilterable-float");
            }
            return known("float");
        }
        return shape.wrapper._sampleType === "float" ? known("float") : unknown();
    } catch {
        return unknown();
    }
}

function readColorSpace(format: InspectionDatum<string>, sampleCategory: InspectionDatum<TextureSampleCategory>): "linear" | "srgb" | "unknown" {
    if (format.state !== "known" || sampleCategory.state !== "known" || sampleCategory.value === "depth" || sampleCategory.value === "sint" || sampleCategory.value === "uint") {
        return "unknown";
    }
    return format.value.endsWith("-srgb") ? "srgb" : "linear";
}

function readName(shape: TextureShape): InspectionDatum<string> {
    try {
        if (typeof shape.wrapper.name === "string" && shape.wrapper.name.length > 0) {
            return known(shape.wrapper.name);
        }
        return stringDatum(shape.gpuTexture?.label);
    } catch {
        return unknown();
    }
}

function readRetainedSampler(shape: TextureShape): RetainedSampler | undefined {
    try {
        if (shape.kind === "cube") {
            return { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" };
        }
        const source = shape.wrapper._recoverySource as Texture2DRecoverySource | undefined;
        switch (source?.kind) {
            case "url": {
                const options = source.opts;
                const hasMipmaps = options?.mipMaps !== false;
                const minFilter = options?.minFilter ?? "linear";
                const magFilter = options?.magFilter ?? "linear";
                const mipmapFilter = hasMipmaps ? "linear" : "nearest";
                return {
                    addressModeU: options?.addressModeU ?? "repeat",
                    addressModeV: options?.addressModeV ?? "repeat",
                    minFilter,
                    magFilter,
                    mipmapFilter,
                    maxAnisotropy: hasMipmaps && minFilter === "linear" && magFilter === "linear" && mipmapFilter === "linear" ? 4 : 1,
                };
            }
            case "solid":
                return { magFilter: "linear", minFilter: "linear" };
            case "pixels":
                return {
                    addressModeU: source.options?.addressModeU,
                    addressModeV: source.options?.addressModeV,
                    minFilter: source.options?.minFilter,
                    magFilter: source.options?.magFilter,
                };
            case "external":
            case "render":
            case "dynamic":
                return source.samplerDesc;
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}

function addressDatum(value: unknown): InspectionDatum<GPUAddressMode> {
    const normalized = value ?? "clamp-to-edge";
    return normalized === "clamp-to-edge" || normalized === "repeat" || normalized === "mirror-repeat" ? known(normalized) : unknown();
}

function filterDatum(value: unknown): InspectionDatum<GPUFilterMode> {
    const normalized = value ?? "nearest";
    return normalized === "nearest" || normalized === "linear" ? known(normalized) : unknown();
}

function anisotropyDatum(value: unknown): InspectionDatum<number> {
    const normalized = value ?? 1;
    return typeof normalized === "number" && Number.isInteger(normalized) && normalized >= 1 ? known(normalized) : unknown();
}

function transformValue(shape: TextureShape, origin: InspectionDatum<TextureInspectionOrigin>): InspectionValue<TextureInspectionTransform> {
    if (shape.kind !== "2d" || (origin.state === "known" && (origin.value === "render-target" || origin.value === "sampled-depth"))) {
        return unsupported();
    }
    try {
        const uOffset = transformNumber(shape.wrapper.uOffset, 0);
        const vOffset = transformNumber(shape.wrapper.vOffset, 0);
        const uScale = transformNumber(shape.wrapper.uScale, 1);
        const vScale = transformNumber(shape.wrapper.vScale, 1);
        const uAng = transformNumber(shape.wrapper.uAng, 0);
        if (uOffset === undefined || vOffset === undefined || uScale === undefined || vScale === undefined || uAng === undefined) {
            return unsupported();
        }
        return present({
            uOffset,
            vOffset,
            uScale,
            vScale,
            uAng,
        });
    } catch {
        return unsupported();
    }
}

function transformNumber(value: unknown, fallback: number): number | undefined {
    return value === undefined ? fallback : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invertYValue(shape: TextureShape): InspectionValue<boolean> {
    if (shape.kind !== "2d") {
        return unsupported();
    }
    try {
        return present(shape.wrapper.invertY === true);
    } catch {
        return unsupported();
    }
}

function readRenderAttachment(shape: TextureShape): InspectionDatum<boolean> {
    try {
        const usage = shape.gpuTexture?.usage;
        return typeof usage === "number" ? known((usage & TU.RENDER_ATTACHMENT) !== 0) : unknown();
    } catch {
        return unknown();
    }
}

function readDynamicUpdate(origin: InspectionDatum<TextureInspectionOrigin>): InspectionDatum<boolean> {
    if (origin.state !== "known" || origin.value === "unknown") {
        return unknown();
    }
    return known(origin.value === "dynamic" || origin.value === "html");
}

function readHtmlReadiness(shape: TextureShape, origin: InspectionDatum<TextureInspectionOrigin>): InspectionDatum<"pending" | "ready" | "failed" | "disposed"> {
    if (origin.state !== "known" || origin.value !== "html") {
        return unknown();
    }
    try {
        if (shape.wrapper._disposed === true) {
            return known("disposed");
        }
        const state = shape.wrapper._readyState;
        return state === "pending" || state === "ready" || state === "failed" ? known(state) : unknown();
    } catch {
        return unknown();
    }
}

function readReleased(shape: TextureShape, origin: InspectionDatum<TextureInspectionOrigin>): InspectionDatum<boolean> {
    if (origin.state === "known" && origin.value === "html") {
        try {
            return typeof shape.wrapper._disposed === "boolean" ? known(shape.wrapper._disposed) : unknown();
        } catch {
            return unknown();
        }
    }
    if (!shape.gpuTexture) {
        return unknown();
    }
    try {
        const references = _getTextureReferenceCount(shape.gpuTexture as unknown as GPUTexture);
        return references === undefined ? unknown() : known(references <= 0);
    } catch {
        return unknown();
    }
}

/** Return a side-effect-free, handle-free metadata snapshot for a supported Lite texture. */
export function inspectTexture(texture: unknown): TextureInspection | undefined {
    const shape = detectTextureShape(texture);
    if (!shape) {
        return undefined;
    }
    try {
        const origin = readOrigin(shape);
        const format = readFormat(shape);
        const sampleCategory = readSampleCategory(shape, format);
        const retainedSampler = readRetainedSampler(shape);
        return {
            kind: shape.kind,
            displayName: readName(shape),
            origin,
            width: shape.width,
            height: shape.height,
            depthOrLayers: known(shape.depthOrLayers),
            sampleCategory: sampleCategory.state === "known" ? sampleCategory.value : "unknown",
            format,
            mipLevelCount: numberDatum(shape.gpuTexture?.mipLevelCount, 1),
            colorSpace: readColorSpace(format, sampleCategory),
            invertY: invertYValue(shape),
            sampler: {
                addressModeU: retainedSampler ? addressDatum(retainedSampler.addressModeU) : unknown(),
                addressModeV: retainedSampler ? addressDatum(retainedSampler.addressModeV) : unknown(),
                addressModeW: retainedSampler ? addressDatum(retainedSampler.addressModeW) : unknown(),
                magFilter: retainedSampler ? filterDatum(retainedSampler.magFilter) : unknown(),
                minFilter: retainedSampler ? filterDatum(retainedSampler.minFilter) : unknown(),
                mipmapFilter: retainedSampler ? filterDatum(retainedSampler.mipmapFilter) : unknown(),
                maxAnisotropy: retainedSampler ? anisotropyDatum(retainedSampler.maxAnisotropy) : unknown(),
            },
            transform: transformValue(shape, origin),
            capabilities: {
                renderAttachment: readRenderAttachment(shape),
                dynamicUpdate: readDynamicUpdate(origin),
                htmlReadiness: readHtmlReadiness(shape, origin),
                released: readReleased(shape, origin),
                sampledDepth: sampleCategory.state === "known" && sampleCategory.value === "depth",
            },
        };
    } catch {
        return undefined;
    }
}

function normalizeTransform(transform: TextureInspectionTransform): TextureInspectionTransform {
    if (!isRecord(transform)) {
        throw new TypeError("Texture transform must be an object.");
    }
    const values = [transform.uOffset, transform.vOffset, transform.uScale, transform.vScale, transform.uAng];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new RangeError("Texture transform values must be finite numbers.");
    }
    return {
        uOffset: Object.is(transform.uOffset, -0) ? 0 : transform.uOffset,
        vOffset: Object.is(transform.vOffset, -0) ? 0 : transform.vOffset,
        uScale: Object.is(transform.uScale, -0) ? 0 : transform.uScale,
        vScale: Object.is(transform.vScale, -0) ? 0 : transform.vScale,
        uAng: Object.is(transform.uAng, -0) ? 0 : transform.uAng,
    };
}

function sameTransform(a: TextureInspectionTransform, b: TextureInspectionTransform): boolean {
    return a.uOffset === b.uOffset && a.vOffset === b.vOffset && a.uScale === b.uScale && a.vScale === b.vScale && a.uAng === b.uAng;
}

function transformCapableBinding(family: "standard" | "pbr", bindingId: string, textureKind: TextureInspectionKind): boolean {
    if (textureKind !== "2d") {
        return false;
    }
    return family === "pbr" || (family === "standard" && bindingId !== "standard.reflection2d" && bindingId !== "standard.reflectionCube");
}

function plannedMutation(source: Material, family: "standard" | "pbr"): AppliedMaterialMutationClass {
    if (family === "standard") {
        return "R";
    }
    const material = source as Material & { readonly _hasUvTx?: boolean; readonly _renderFeatures?: unknown };
    return material._hasUvTx === true || material._renderFeatures === undefined ? "U" : "R";
}

function discoverConsumers(scenes: readonly SceneContext[], texture: object): TextureConsumer[] {
    const consumers = new Map<object, TextureConsumer>();
    for (const scene of scenes) {
        const seenInScene = new Set<object>();
        for (const mesh of scene.meshes) {
            let inspection;
            try {
                inspection = inspectMaterial(mesh.material);
            } catch {
                inspection = undefined;
            }
            if (!inspection || seenInScene.has(inspection.source)) {
                continue;
            }
            seenInScene.add(inspection.source);
            if (inspection.family !== "standard" && inspection.family !== "pbr") {
                continue;
            }
            const family = inspection.family;
            let consumes = false;
            for (const binding of getMaterialTextureBindings(mesh.material)) {
                if (binding.value.state === "present" && binding.value.value.entity === texture && transformCapableBinding(family, binding.id, binding.value.value.kind)) {
                    consumes = true;
                    break;
                }
            }
            if (!consumes) {
                continue;
            }
            const existing = consumers.get(inspection.source);
            if (existing) {
                if (!existing.scenes.includes(scene)) {
                    existing.scenes.push(scene);
                }
                continue;
            }
            consumers.set(inspection.source, {
                source: inspection.source,
                family,
                scenes: [scene],
                mutation: plannedMutation(inspection.source, family),
            });
        }
    }
    return [...consumers.values()];
}

function resultFor(mutation: AppliedMaterialMutationClass, changed: boolean): MaterialInspectionMutationResult {
    return {
        changed,
        mutation,
        postMutation: changed && mutation === "R" ? "rebuild-material" : "none",
    };
}

/**
 * Commit a texture transform to the exact wrapper object used by canonical
 * Standard/PBR bindings in the supplied scenes.
 */
export async function setTextureInspectionTransform(
    scope: MaterialInspectionMutationScope,
    texture: object,
    transform: TextureInspectionTransform
): Promise<MaterialInspectionMutationResult> {
    const normalized = normalizeTransform(transform);
    const inspection = inspectTexture(texture);
    if (!inspection || inspection.transform.state !== "present") {
        throw new Error("This texture does not support inspection transform edits.");
    }
    const scenes = [...new Set(_validateInspectionScopeScenes(scope))];
    const consumers = discoverConsumers(scenes, texture);
    if (consumers.length === 0) {
        throw new Error("The texture has no transform-capable Standard or PBR consumer in the supplied scenes.");
    }
    const mutation: AppliedMaterialMutationClass = consumers.some((consumer) => consumer.mutation === "R") ? "R" : "U";
    if (sameTransform(inspection.transform.value, normalized)) {
        return resultFor(mutation, false);
    }

    for (const consumer of consumers) {
        if (consumer.family === "standard") {
            enableMaterialUvTransform(consumer.source);
        } else {
            const hadUvTransform = (consumer.source as Material & { readonly _hasUvTx?: boolean })._hasUvTx === true;
            const firstBuild = enableMaterialUvTransform(consumer.source);
            consumer.mutation = hadUvTransform || firstBuild ? "U" : "R";
        }
    }

    const target = texture as Texture2D;
    target.uOffset = normalized.uOffset;
    target.vOffset = normalized.vOffset;
    target.uScale = normalized.uScale;
    target.vScale = normalized.vScale;
    target.uAng = normalized.uAng;

    const effectiveMutation: AppliedMaterialMutationClass = consumers.some((consumer) => consumer.mutation === "R") ? "R" : "U";
    const rebuilds: Promise<void>[] = [];
    for (const consumer of consumers) {
        if (consumer.mutation === "U") {
            markMaterialUboDirty(consumer.source);
        } else {
            for (const scene of consumer.scenes) {
                rebuilds.push(rebuildMaterial(scene, consumer.source, { rebuildViews: true, rebuildFrameGraph: false, awaitCompletion: true }));
            }
        }
    }
    await Promise.all(rebuilds);
    return resultFor(effectiveMutation, true);
}
