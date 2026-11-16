import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container.js";
import { goToFrame } from "../../../packages/babylon-lite/src/animation/animation-group.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { collectBaseColorDefs, prepareMaterial, resolveBaseColorPointer } from "../../../packages/babylon-lite/src/loader-gltf/animation-pointer-basecolor.js";
import { assembleMaterial } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material.js";
import { applyGltfOptInPbrFeatures, assemblePbrProps } from "../../../packages/babylon-lite/src/loader-gltf/gltf-pbr-builder.js";
import { loadGltf } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf.js";
import { resetVariant, selectVariant } from "../../../packages/babylon-lite/src/loader-gltf/material-variants.js";
import { collectPbrBoundTextures } from "../../../packages/babylon-lite/src/material/pbr/collect-pbr-bound-textures.js";
import { writeUnlitUBO } from "../../../packages/babylon-lite/src/material/pbr/fragments/unlit-fragment.js";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { _computePbrMaterialFeatures } from "../../../packages/babylon-lite/src/material/pbr/pbr-material-features.js";
import { PBR2_HAS_BASE_COLOR_FACTOR } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags.js";
import { _writeMaterialData } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";
import { computeUboLayout } from "../../../packages/babylon-lite/src/shader/ubo-layout.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";

// KTX2 transcoding is out of scope: the extension's upload returns a ready 4×4 texture that the
// loader never creates through the device, so every `createTexture` below is a loader upload.
vi.mock("../../../packages/babylon-lite/src/texture/ktx2-loader.js", () => ({
    decodeKtx2ImageBitmapFromBuffer: vi.fn(),
    uploadKtx2Texture2D: vi.fn(async (): Promise<Texture2D> => ({
        texture: { destroy: vi.fn() } as unknown as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 4,
        height: 4,
        invertY: true,
    })),
}));
// Mip generation needs real pipelines; the upload itself is what is counted here.
vi.mock("../../../packages/babylon-lite/src/texture/generate-mipmaps.js", () => ({ generateMipmaps: vi.fn() }));

/** Decoded PNG images are 8×8, KTX2 textures 4×4, factor fallbacks 1×1. */
const IMAGE_SIZE = 8;

beforeEach(() => {
    vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async (source: { width?: number; height?: number }) => ({ width: source.width ?? IMAGE_SIZE, height: source.height ?? IMAGE_SIZE, close: vi.fn() }))
    );
    // ORM compositing draws the two images into canvases; only the pixel plumbing is stubbed.
    vi.stubGlobal(
        "OffscreenCanvas",
        class {
            constructor(
                public width: number,
                public height: number
            ) {}
            getContext() {
                return { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: vi.fn() };
            }
        }
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

function align4(value: number): number {
    return (value + 3) & ~3;
}

type Path = "fast" | "uv-transform" | "glTF sampler" | "variants";
const PATHS: Path[] = ["fast", "uv-transform", "glTF sampler", "variants"];

/** Material 0 ("subject") is the one under test; material 1 ("factors") is factor-only, so its
 *  1×1 base-color and ORM fallbacks are genuinely bound. */
interface Scenario {
    extensionsUsed: string[];
    subject: Record<string, unknown>;
    textures: Record<string, unknown>[];
    images: ("ktx2" | "png")[];
    baseColorAnimation?: readonly [readonly number[], readonly number[], ...(readonly number[][])];
    subjectOnlyInVariants?: boolean;
}

function makeGlb(scenario: Scenario, path: Path): ArrayBuffer {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const imageBytes = new Uint8Array([0xab, 0x4b, 0x54, 0x58]);
    const animationTimes = new Float32Array(Array.from({ length: scenario.baseColorAnimation?.length ?? 0 }, (_, i) => i));
    const animationColors = new Float32Array(scenario.baseColorAnimation?.flat() ?? []);

    const normalOffset = positions.byteLength;
    const uvOffset = normalOffset + normals.byteLength;
    const indexOffset = uvOffset + uvs.byteLength;
    const imageOffset = align4(indexOffset + indices.byteLength);
    const timeOffset = imageOffset + imageBytes.byteLength;
    const colorOffset = timeOffset + animationTimes.byteLength;
    const binaryByteLength = colorOffset + animationColors.byteLength;
    const binary = new Uint8Array(align4(binaryByteLength));
    binary.set(new Uint8Array(positions.buffer), 0);
    binary.set(new Uint8Array(normals.buffer), normalOffset);
    binary.set(new Uint8Array(uvs.buffer), uvOffset);
    binary.set(new Uint8Array(indices.buffer), indexOffset);
    binary.set(imageBytes, imageOffset);
    binary.set(new Uint8Array(animationTimes.buffer), timeOffset);
    binary.set(new Uint8Array(animationColors.buffer), colorOffset);

    const attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
    const textures = scenario.textures.map((texture, i) => (path === "glTF sampler" && i === 0 ? { ...texture, sampler: 0 } : texture));
    const json = {
        asset: { version: "2.0" },
        extensionsUsed: [
            ...scenario.extensionsUsed,
            ...(path === "uv-transform" && !scenario.extensionsUsed.includes("KHR_texture_transform") ? ["KHR_texture_transform"] : []),
            ...(path === "variants" ? ["KHR_materials_variants"] : []),
            ...(scenario.baseColorAnimation ? ["KHR_animation_pointer"] : []),
        ],
        ...(path === "variants" ? { extensions: { KHR_materials_variants: { variants: [{ name: "subject" }] } } } : {}),
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "node", mesh: 0 }],
        meshes: [
            {
                name: "mesh",
                primitives: [
                    { attributes, indices: 3, material: scenario.subjectOnlyInVariants ? 1 : 0 },
                    {
                        attributes,
                        indices: 3,
                        material: 1,
                        ...(path === "variants" ? { extensions: { KHR_materials_variants: { mappings: [{ material: 0, variants: [0] }] } } } : {}),
                    },
                ],
            },
        ],
        materials: [
            { name: "subject", ...scenario.subject },
            { name: "factors", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.125, 1], metallicFactor: 0.5, roughnessFactor: 0.5 } },
        ],
        textures,
        // A clamp sampler routes material building through the sampler-aware builders.
        ...(path === "glTF sampler" ? { samplers: [{ wrapS: 33071, wrapT: 33071 }] } : {}),
        images: scenario.images.map((kind) => ({ bufferView: 4, mimeType: kind === "ktx2" ? "image/ktx2" : "image/png" })),
        buffers: [{ byteLength: binaryByteLength }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
            { buffer: 0, byteOffset: normalOffset, byteLength: normals.byteLength },
            { buffer: 0, byteOffset: uvOffset, byteLength: uvs.byteLength },
            { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength },
            { buffer: 0, byteOffset: imageOffset, byteLength: imageBytes.byteLength },
            ...(scenario.baseColorAnimation
                ? [
                      { buffer: 0, byteOffset: timeOffset, byteLength: animationTimes.byteLength },
                      { buffer: 0, byteOffset: colorOffset, byteLength: animationColors.byteLength },
                  ]
                : []),
        ],
        accessors: [
            { bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 2, componentType: FLOAT, count: 3, type: "VEC2" },
            { bufferView: 3, componentType: UNSIGNED_SHORT, count: 3, type: "SCALAR" },
            ...(scenario.baseColorAnimation
                ? [
                      { bufferView: 5, componentType: FLOAT, count: animationTimes.length, type: "SCALAR", min: [0], max: [animationTimes.length - 1] },
                      { bufferView: 6, componentType: FLOAT, count: animationTimes.length, type: "VEC4" },
                  ]
                : []),
        ],
        ...(scenario.baseColorAnimation
            ? {
                  animations: [
                      {
                          name: "baseColor",
                          samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }],
                          channels: [
                              { sampler: 0, target: { path: "pointer", extensions: { KHR_animation_pointer: { pointer: "/materials/0/pbrMetallicRoughness/baseColorFactor" } } } },
                          ],
                      },
                  ],
              }
            : {}),
    };

    const encodedJson = new TextEncoder().encode(JSON.stringify(json));
    const jsonByteLength = align4(encodedJson.byteLength);
    const totalByteLength = 12 + 8 + jsonByteLength + 8 + binary.byteLength;
    const glb = new ArrayBuffer(totalByteLength);
    const view = new DataView(glb);
    const bytes = new Uint8Array(glb);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalByteLength, true);
    view.setUint32(12, jsonByteLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20, 20 + jsonByteLength);
    bytes.set(encodedJson, 20);
    const binaryHeaderOffset = 20 + jsonByteLength;
    view.setUint32(binaryHeaderOffset, binary.byteLength, true);
    view.setUint32(binaryHeaderOffset + 4, 0x004e4942, true);
    bytes.set(binary, binaryHeaderOffset + 8);
    return glb;
}

interface CreatedTexture {
    readonly texture: GPUTexture;
    readonly label: string;
}

function makeMockEngine(): { engine: EngineContext; created: CreatedTexture[]; fallbackPixels: Map<GPUTexture, Uint8Array> } {
    const created: CreatedTexture[] = [];
    const fallbackPixels = new Map<GPUTexture, Uint8Array>();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return { destroy: vi.fn(), getMappedRange: vi.fn(() => storage), unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const texture = { createView: vi.fn(() => ({}) as GPUTextureView), destroy: vi.fn() } as unknown as GPUTexture;
            const size = descriptor.size as GPUExtent3DDict;
            created.push({ texture, label: `${descriptor.format} ${size.width}x${size.height ?? 1}` });
            return texture;
        }),
        queue: {
            copyExternalImageToTexture: vi.fn(),
            writeTexture: vi.fn((destination: { texture: GPUTexture }, pixels: Uint8Array) => {
                fallbackPixels.set(destination.texture, pixels.slice());
            }),
        },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, created, fallbackPixels };
}

function collectMaterials(container: AssetContainer): PbrMaterialProps[] {
    const materials = new Set<PbrMaterialProps>();
    const visit = (node: { material?: unknown; children?: unknown[] }): void => {
        if (node.material) {
            materials.add(node.material as PbrMaterialProps);
        }
        node.children?.forEach((child) => visit(child as typeof node));
    };
    container.entities.forEach((entity) => visit(entity as { children?: unknown[] }));
    const variants = container.materialVariants;
    if (variants) {
        [variants.originals, ...Object.values(variants.variants)].flat().forEach(({ material }) => materials.add(material as PbrMaterialProps));
    }
    return [...materials];
}

async function load(
    scenario: Scenario,
    path: Path
): Promise<{
    subjects: PbrMaterialProps[];
    factors: PbrMaterialProps[];
    unowned: string[];
    fallbackPixels: Map<GPUTexture, Uint8Array>;
    animationGroups: AssetContainer["animationGroups"];
    container: AssetContainer;
}> {
    const { engine, created, fallbackPixels } = makeMockEngine();
    const container = await loadGltf(engine, makeGlb(scenario, path));
    const materials = collectMaterials(container);
    // A material's textures are acquired by its renderables and destroyed by their last release.
    // A GPU texture the loader created that no loaded material binds is unreachable from every
    // owner, so nothing ever destroys it deterministically.
    const bound = new Set(materials.flatMap((material) => collectPbrBoundTextures(material).map((texture) => texture.texture)));
    return {
        subjects: materials.filter((material) => material.name === "subject"),
        factors: materials.filter((material) => material.name === "factors"),
        unowned: created.filter(({ texture }) => !bound.has(texture)).map(({ label }) => label),
        fallbackPixels,
        animationGroups: container.animationGroups,
        container,
    };
}

const BASISU = "KHR_texture_basisu";
const SPEC_GLOSS = "KHR_materials_pbrSpecularGlossiness";
const ktx2 = (source: number) => ({ extensions: { KHR_texture_basisu: { source } } });
const png = (source: number) => ({ source });

/** Each scenario: a material feature supplies the subject's `slot` through `extLayers`, and the
 *  bound texture of that slot has `width` (4 = KTX2, 8 = decoded image). */
const SCENARIOS: [name: string, scenario: Scenario, checks: [slot: "baseColorTexture" | "ormTexture", width: number][]][] = [
    [
        "KHR_texture_basisu base color and metallic-roughness (factor fallbacks displaced)",
        {
            extensionsUsed: [BASISU],
            subject: { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } } },
            textures: [ktx2(0), ktx2(1)],
            images: ["ktx2", "ktx2"],
        },
        [
            ["baseColorTexture", 4],
            ["ormTexture", 4],
        ],
    ],
    [
        "KHR_texture_basisu metallic-roughness beside a PNG occlusion (occlusion image upload displaced)",
        {
            extensionsUsed: [BASISU],
            subject: { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } }, occlusionTexture: { index: 1 } },
            textures: [ktx2(0), png(1)],
            images: ["ktx2", "png"],
        },
        [["ormTexture", 4]],
    ],
    [
        "separate metallic-roughness and occlusion images (ORM composite displaces the metallic-roughness upload)",
        {
            extensionsUsed: [],
            subject: { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } }, occlusionTexture: { index: 1 } },
            textures: [png(0), png(1)],
            images: ["png", "png"],
        },
        [["ormTexture", IMAGE_SIZE]],
    ],
    [
        "KHR_materials_pbrSpecularGlossiness diffuse (factor fallback displaced)",
        {
            extensionsUsed: [SPEC_GLOSS],
            subject: { extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: 0 } } } },
            textures: [png(0)],
            images: ["png"],
        },
        [["baseColorTexture", IMAGE_SIZE]],
    ],
    [
        "KHR_materials_pbrSpecularGlossiness diffuse beside a metallic-roughness base color (core image upload displaced)",
        {
            extensionsUsed: [SPEC_GLOSS],
            subject: { pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: 0 } } } },
            textures: [png(0), png(1)],
            images: ["png", "png"],
        },
        [["baseColorTexture", IMAGE_SIZE]],
    ],
];

describe("glTF material textures displaced by a material feature", () => {
    describe.each(SCENARIOS)("%s", (_name, scenario, checks) => {
        it.each(PATHS)("uploads nothing that no material binds (%s path)", async (path) => {
            const { subjects, factors, unowned } = await load(scenario, path);

            expect(subjects.length).toBeGreaterThan(0);
            for (const subject of subjects) {
                for (const [slot, width] of checks) {
                    expect(subject[slot]?.width, slot).toBe(width);
                }
            }
            expect(unowned, "GPU textures uploaded by the loader that no loaded material binds").toEqual([]);

            // The factor-only material still gets, and binds, its own 1×1 fallbacks.
            expect(factors).toHaveLength(1);
            expect(factors[0]!.baseColorTexture?.width).toBe(1);
            expect(factors[0]!.ormTexture?.width).toBe(1);
        });
    });

    // The slow path derives `_uv2Mask` and the uv-transform opt-in from the displaced slot's core
    // textureInfo. Skipping its upload must keep both exactly as they were.
    it("keeps the core textureInfo's UV set and transform for a displaced slot on the slow path", async () => {
        const transform = { KHR_texture_transform: { offset: [0.5, 0] } };
        const { subjects: orm } = await load(
            {
                extensionsUsed: ["KHR_texture_transform"],
                subject: { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0, texCoord: 1, extensions: transform } }, occlusionTexture: { index: 1 } },
                textures: [png(0), png(1)],
                images: ["png", "png"],
            },
            "uv-transform"
        );
        expect(orm[0]!._uv2Mask).toBe(2);
        expect(orm[0]!._hasUvTx).toBe(true);

        const { subjects: baseColor } = await load(
            {
                extensionsUsed: [SPEC_GLOSS, "KHR_texture_transform"],
                subject: {
                    pbrMetallicRoughness: { baseColorTexture: { index: 1, texCoord: 1, extensions: transform } },
                    extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: 0 } } },
                },
                textures: [png(0), png(1)],
                images: ["png", "png"],
            },
            "uv-transform"
        );
        expect(baseColor[0]!._uv2Mask).toBe(1);
        expect(baseColor[0]!._hasUvTx).toBe(true);
    });
});

describe("glTF baseColorFactor on a KHR_texture_basisu base color", () => {
    const FACTOR = [0.5, 0.25, 0.125, 0.75];
    const RGB_ONLY = [0.5, 0.25, 0.125, 1];
    const subject = (baseColorFactor: number[] | undefined, alphaMode?: "BLEND" | "MASK") => ({
        ...(alphaMode ? { alphaMode } : {}),
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, ...(baseColorFactor ? { baseColorFactor } : {}) },
    });
    const loadKtx2 = (baseColorFactor: number[] | undefined, alphaMode: "BLEND" | "MASK" | undefined, path: Path) =>
        load({ extensionsUsed: [BASISU], subject: subject(baseColorFactor, alphaMode), textures: [ktx2(0)], images: ["ktx2"] }, path);

    // The factor multiplies the base color texture, so a KTX2 texture must carry its RGB exactly like a
    // decoded PNG does — the extension strips the textureInfo, so the core sees no base color image.
    it.each(PATHS)("multiplies a non-default factor's RGB into the KTX2 texture like a PNG one (%s path)", async (path) => {
        const { subjects: ktx2Subjects } = await loadKtx2(FACTOR, undefined, path);
        const { subjects: pngSubjects } = await load({ extensionsUsed: [], subject: subject(FACTOR), textures: [png(0)], images: ["png"] }, path);

        expect(pngSubjects[0]!.baseColorFactor?.slice(0, 3)).toEqual(RGB_ONLY.slice(0, 3));
        expect(ktx2Subjects.length).toBeGreaterThan(0);
        for (const material of ktx2Subjects) {
            expect(material.baseColorTexture?.width).toBe(4);
            // OPAQUE ignores alpha, so the factor alpha is not forwarded.
            expect(material.baseColorFactor).toEqual(RGB_ONLY);
        }
    });

    // The shader multiplies the factor alpha into the texel alpha and then by the material `alpha`,
    // which BLEND/MASK already set to the factor alpha. Forwarding it in the factor too would square it.
    it.each((["BLEND", "MASK"] as const).flatMap((mode) => PATHS.map((path) => [mode, path] as const)))(
        "applies the factor alpha once, as the material alpha (%s, %s path)",
        async (mode, path) => {
            const { subjects } = await loadKtx2(FACTOR, mode, path);

            expect(subjects.length).toBeGreaterThan(0);
            for (const material of subjects) {
                expect(material.alpha).toBe(0.75);
                expect(material.baseColorFactor).toEqual(RGB_ONLY);
            }
        }
    );

    it.each(PATHS)("adds no factor for the default white (%s path)", async (path) => {
        const { subjects } = await loadKtx2(undefined, undefined, path);

        expect(subjects.length).toBeGreaterThan(0);
        for (const material of subjects) {
            expect(material.baseColorFactor).toBeUndefined();
        }
    });

    it.each(PATHS)("adds no factor for a white RGB with a non-default alpha (%s path)", async (path) => {
        const { subjects } = await loadKtx2([1, 1, 1, 0.5], "BLEND", path);

        expect(subjects.length).toBeGreaterThan(0);
        for (const material of subjects) {
            expect(material.alpha).toBe(0.5);
            expect(material.baseColorFactor).toBeUndefined();
        }
    });
});

describe("glTF PNG baseColorFactor is applied once", () => {
    const FACTOR = [0.5, 0.25, 0.125, 0.5];
    const RGB_ONLY = [0.5, 0.25, 0.125, 1];
    const loadPng = (factor: number[] | undefined, mode: "OPAQUE" | "BLEND" | "MASK", path: Path) =>
        load(
            {
                extensionsUsed: [],
                subject: {
                    alphaMode: mode,
                    alphaCutoff: 0.3,
                    pbrMetallicRoughness: {
                        ...(factor ? { baseColorFactor: factor } : {}),
                        baseColorTexture: {
                            index: 0,
                            ...(path === "uv-transform" ? { extensions: { KHR_texture_transform: { offset: [0.25, 0.5] } } } : {}),
                        },
                    },
                },
                textures: [png(0)],
                images: ["png"],
            },
            path
        );

    it.each((["OPAQUE", "BLEND", "MASK"] as const).flatMap((mode) => PATHS.map((path) => [mode, path] as const)))(
        "keeps RGB and alpha in separate owners (%s, %s path)",
        async (mode, path) => {
            const { subjects, unowned } = await loadPng(FACTOR, mode, path);

            expect(subjects.length).toBeGreaterThan(0);
            if (path === "variants") {
                expect(subjects.length).toBeGreaterThan(1);
            }
            expect(unowned).toEqual([]);
            for (const material of subjects) {
                expect(material.baseColorTexture?.width).toBe(IMAGE_SIZE);
                expect(material.baseColorFactor).toEqual(RGB_ONLY);
                expect(material.alpha).toBe(mode === "OPAQUE" ? undefined : 0.5);
                expect(material.alphaBlend).toBe(mode === "BLEND" ? true : undefined);
                if (path === "uv-transform") {
                    expect(material._hasUvTx).toBe(true);
                }
                if (mode !== "OPAQUE") {
                    const opacity = 0.8 * material.baseColorFactor![3] * material.alpha!;
                    expect(opacity).toBe(0.4);
                    if (mode === "MASK") {
                        expect(material._alphaCutOff).toBe(0.3);
                        expect(opacity).toBeGreaterThan(material._alphaCutOff!);
                    }
                }
            }
        }
    );

    it.each((["BLEND", "MASK"] as const).flatMap((mode) => PATHS.map((path) => [mode, path] as const)))(
        "does not add an RGB factor for white with non-default alpha (%s, %s path)",
        async (mode, path) => {
            const { subjects } = await loadPng([1, 1, 1, 0.5], mode, path);

            expect(subjects.length).toBeGreaterThan(0);
            for (const material of subjects) {
                expect(material.baseColorFactor).toBeUndefined();
                expect(material.alpha).toBe(0.5);
            }
        }
    );

    it.each(PATHS)("keeps the default white factor implicit (%s path)", async (path) => {
        const { subjects } = await loadPng(undefined, "OPAQUE", path);

        expect(subjects.length).toBeGreaterThan(0);
        for (const material of subjects) {
            expect(material.baseColorFactor).toBeUndefined();
            expect(material.alpha).toBeUndefined();
        }
    });
});

describe("glTF unlit base color is tinted once", () => {
    it.each((["png", "ktx2", "factor-only"] as const).flatMap((source) => PATHS.map((path) => [source, path] as const)))(
        "leaves the unlit tint neutral (%s, %s path)",
        async (source, path) => {
            const { subjects, unowned } = await load(
                {
                    extensionsUsed: ["KHR_materials_unlit", ...(source === "ktx2" ? [BASISU] : [])],
                    subject: {
                        extensions: { KHR_materials_unlit: {} },
                        pbrMetallicRoughness: {
                            baseColorFactor: [0.5, 0.25, 0.125, 1],
                            ...(source === "factor-only"
                                ? {}
                                : {
                                      baseColorTexture: {
                                          index: 0,
                                          ...(path === "uv-transform" ? { extensions: { KHR_texture_transform: { offset: [0.25, 0.5] } } } : {}),
                                      },
                                  }),
                        },
                    },
                    textures: source === "factor-only" ? [] : [source === "png" ? png(0) : ktx2(0)],
                    images: source === "factor-only" ? [] : [source],
                },
                path
            );

            expect(subjects.length).toBeGreaterThan(0);
            expect(unowned).toEqual([]);
            for (const material of subjects) {
                expect(material._unlit).toBe(true);
                expect(material._unlitColor).toBeUndefined();
                const data = new Float32Array(4);
                writeUnlitUBO(data, material, new Map([["unlitColor", 0]]));
                expect([...data]).toEqual([1, 1, 1, 0]);
                expect(material.baseColorTexture?.width).toBe(source === "factor-only" ? 1 : source === "png" ? IMAGE_SIZE : 4);
                expect(material.baseColorFactor).toEqual(source === "factor-only" ? undefined : [0.5, 0.25, 0.125, 1]);
                if (source !== "factor-only") {
                    const texel = [0.8, 0.6, 0.4];
                    expect(texel.map((value, i) => value * material.baseColorFactor![i]! * data[i]!)).toEqual([0.4, 0.15, 0.05]);
                }
            }
        }
    );
});

describe("glTF factor-only alpha is applied once", () => {
    it.each((["BLEND", "MASK"] as const).flatMap((mode) => PATHS.flatMap((path) => [0, 0.5, 1].map((alpha) => [mode, path, alpha] as const))))(
        "keeps fallback alpha neutral (%s, %s path, alpha %s)",
        async (mode, path, alpha) => {
            const { subjects, fallbackPixels, unowned } = await load(
                {
                    extensionsUsed: [],
                    subject: {
                        alphaMode: mode,
                        alphaCutoff: 0.3,
                        pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.125, alpha] },
                    },
                    textures: [],
                    images: [],
                },
                path
            );

            expect(subjects.length).toBeGreaterThan(0);
            expect(unowned).toEqual([]);
            for (const material of subjects) {
                expect(material.baseColorFactor).toBeUndefined();
                expect(material.alpha).toBe(alpha);
                const pixels = fallbackPixels.get(material.baseColorTexture!.texture)!;
                expect([...pixels]).toEqual([188, 137, 99, 255]);
                const opacity = (pixels[3]! / 255) * material.alpha!;
                expect(opacity).toBe(alpha);
                if (mode === "MASK") {
                    expect(material._alphaCutOff).toBe(0.3);
                    expect(opacity < material._alphaCutOff!).toBe(alpha === 0);
                }
            }
        }
    );
});

describe("glTF animated white PNG retains its base-color uniform", () => {
    it.each((["BLEND", "MASK"] as const).flatMap((mode) => PATHS.map((path) => [mode, path] as const)))(
        "seeds the slot before rendering and updates its RGB (%s, %s path)",
        async (mode, path) => {
            const { subjects, animationGroups, container } = await load(
                {
                    extensionsUsed: [],
                    subject: {
                        alphaMode: mode,
                        pbrMetallicRoughness: {
                            baseColorFactor: [1, 1, 1, 0.5],
                            baseColorTexture: {
                                index: 0,
                                ...(path === "uv-transform" ? { extensions: { KHR_texture_transform: { offset: [0.25, 0.5] } } } : {}),
                            },
                        },
                    },
                    textures: [png(0)],
                    images: ["png"],
                    baseColorAnimation: [
                        [1, 1, 1, 0.5],
                        [0.5, 0.25, 0.125, 0.5],
                    ],
                },
                path
            );

            expect(subjects).toHaveLength(path === "variants" ? 2 : 1);
            for (const material of subjects) {
                expect(material.baseColorTexture?.width).toBe(IMAGE_SIZE);
                expect(material.baseColorFactor).toBeDefined();
                expect(_computePbrMaterialFeatures(material).features2 & PBR2_HAS_BASE_COLOR_FACTOR).toBe(PBR2_HAS_BASE_COLOR_FACTOR);
            }
            expect(animationGroups).toHaveLength(1);
            const group = animationGroups![0]!;
            group.loopAnimation = false;
            const factors = subjects.map((material) => material.baseColorFactor);
            const versions = subjects.map((material) => material._uboVersion);
            const spec = computeUboLayout([
                { _name: "environmentIntensity", _type: "f32" },
                { _name: "directIntensity", _type: "f32" },
                { _name: "reflectance", _type: "f32" },
                { _name: "materialAlpha", _type: "f32" },
                { _name: "baseColorFactor", _type: "vec4<f32>" },
            ]);
            const data = new Float32Array(spec._totalBytes / 4);
            const offset = spec._offsets.get("baseColorFactor")! / 4;
            for (const [frame, rgb] of [
                [0, [1, 1, 1]],
                [30, [0.75, 0.625, 0.5625]],
                [60, [0.5, 0.25, 0.125]],
            ] as const) {
                goToFrame(group, frame);
                for (const [index, material] of subjects.entries()) {
                    expect(material.baseColorFactor).toBe(factors[index]);
                    expect(material.baseColorFactor!.slice(0, 3)).toEqual(rgb);
                    _writeMaterialData(data, material, spec);
                    expect([...data.slice(offset, offset + 3)]).toEqual(rgb);
                }
                if (path === "variants") {
                    selectVariant(container, "subject");
                    for (const entry of container.materialVariants!.variants.subject!) {
                        const selected = subjects.find((material) => material === entry.mesh.material);
                        expect(selected).toBe(entry.material);
                        _writeMaterialData(data, selected!, spec);
                        expect([...data.slice(offset, offset + 4)]).toEqual([...rgb, 1]);
                        expect(data[3]).toBe(0.5);
                    }
                }
            }
            subjects.forEach((material, index) => expect(material._uboVersion).toBeGreaterThan(versions[index]!));
        }
    );
});

describe("glTF animated base-color alpha is applied once", () => {
    it("keeps the raw glTF factor unchanged while writing every runtime copy", async () => {
        const factor: [number, number, number, number] = [0.5, 0.25, 0.125, 0.5];
        const pointer = "/materials/0/pbrMetallicRoughness/baseColorFactor";
        const json = {
            materials: [{ alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: factor } }],
            animations: [{ channels: [{ target: { extensions: { KHR_animation_pointer: { pointer } } } }] }],
        };
        collectBaseColorDefs(json);
        const resolved = resolveBaseColorPointer(pointer, json)!;
        const copies: PbrMaterialProps[] = [];
        for (let i = 0; i < 2; i++) {
            const parsed = await assembleMaterial(json, new DataView(new ArrayBuffer(0)), 0, "", []);
            const layer = prepareMaterial(parsed)!;
            const material = assemblePbrProps(parsed, undefined, undefined, undefined, undefined, layer);
            await applyGltfOptInPbrFeatures(material, parsed);
            copies.push(material);
        }
        resolved.writer(new Float32Array([0.25, 0.5, 0.75, 0]), 0);
        expect(json.materials[0]!.pbrMetallicRoughness.baseColorFactor).toBe(factor);
        expect(factor).toEqual([0.5, 0.25, 0.125, 0.5]);
        expect(copies[0]!.baseColorFactor).not.toBe(copies[1]!.baseColorFactor);
        for (const material of copies) {
            expect(material.baseColorFactor).toEqual([0.25, 0.5, 0.75, 1]);
            expect(material.alpha).toBe(0);
            expect(material._uboVersion).toBe(1);
        }
    });

    it("keeps runtime target groups isolated between loaded assets", async () => {
        const scenario = (rgb: number[], alpha: number): Scenario => ({
            extensionsUsed: [],
            subject: { alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [...rgb, alpha], baseColorTexture: { index: 0 } } },
            textures: [png(0)],
            images: ["png"],
            baseColorAnimation: [
                [...rgb, alpha],
                [0.25, 0.5, 0.75, 0],
            ],
        });
        const first = await load(scenario([0.5, 0.25, 0.125], 0.5), "variants");
        const second = await load(scenario([1, 1, 1], 0.75), "variants");
        const secondVersions = second.subjects.map((material) => material._uboVersion);
        first.animationGroups![0]!.loopAnimation = false;
        goToFrame(first.animationGroups![0]!, 60);
        for (const material of first.subjects) {
            expect(material.baseColorFactor).toEqual([0.25, 0.5, 0.75, 1]);
            expect(material.alpha).toBe(0);
        }
        for (const [index, material] of second.subjects.entries()) {
            expect(material.baseColorFactor).toEqual([1, 1, 1, 1]);
            expect(material.alpha).toBe(0.75);
            expect(material._uboVersion).toBe(secondVersions[index]);
        }
        const firstVersions = first.subjects.map((material) => material._uboVersion);
        second.animationGroups![0]!.loopAnimation = false;
        goToFrame(second.animationGroups![0]!, 60);
        for (const [index, material] of first.subjects.entries()) {
            expect(material._uboVersion).toBe(firstVersions[index]);
        }
        for (const material of second.subjects) {
            expect(material.baseColorFactor).toEqual([0.25, 0.5, 0.75, 1]);
            expect(material.alpha).toBe(0);
        }
    });

    const cases = (["PNG", "KTX2", "factor-only"] as const).flatMap((source) =>
        (["OPAQUE", "BLEND", "MASK"] as const).flatMap((mode) =>
            (["colored", "white"] as const).flatMap((initial) =>
                (source === "factor-only" ? PATHS.filter((path) => path === "fast" || path === "variants") : PATHS).flatMap((path) =>
                    (path === "variants" ? [false, true] : [false]).map((subjectOnlyInVariants) => [source, mode, initial, path, subjectOnlyInVariants] as const)
                )
            )
        )
    );
    it.each(cases)("preserves alpha through load and interpolation (%s, %s, %s, %s path, variant-only %s)", async (source, mode, initial, path, subjectOnlyInVariants) => {
        const initialRgb = initial === "colored" ? [0.5, 0.25, 0.125] : [1, 1, 1];
        const { subjects, animationGroups, fallbackPixels, unowned, container } = await load(
            {
                subjectOnlyInVariants,
                extensionsUsed: source === "KTX2" ? [BASISU] : [],
                subject: {
                    alphaMode: mode,
                    alphaCutoff: 0.3,
                    pbrMetallicRoughness: {
                        baseColorFactor: [...initialRgb, 0.5],
                        ...(source === "factor-only"
                            ? {}
                            : {
                                  baseColorTexture: {
                                      index: 0,
                                      ...(path === "uv-transform" ? { extensions: { KHR_texture_transform: { offset: [0.25, 0.5] } } } : {}),
                                  },
                              }),
                    },
                },
                textures: source === "factor-only" ? [] : [source === "KTX2" ? ktx2(0) : png(0)],
                images: source === "factor-only" ? [] : [source === "KTX2" ? "ktx2" : "png"],
                baseColorAnimation: [
                    [...initialRgb, 0.5],
                    [0.25, 0.5, 0.75, 0],
                    [1, 1, 1, 1],
                ],
            },
            path
        );

        expect(unowned).toEqual([]);
        expect(subjects).toHaveLength(path === "variants" && !subjectOnlyInVariants ? 2 : 1);
        for (const material of subjects) {
            expect(material.baseColorFactor).toEqual([...initialRgb, 1]);
            expect(material.alpha).toBe(mode === "OPAQUE" ? undefined : 0.5);
            expect(_computePbrMaterialFeatures(material).features2 & PBR2_HAS_BASE_COLOR_FACTOR).toBe(PBR2_HAS_BASE_COLOR_FACTOR);
            expect(material.baseColorTexture?.width).toBe(source === "factor-only" ? 1 : source === "KTX2" ? 4 : IMAGE_SIZE);
            if (source === "factor-only") {
                expect([...fallbackPixels.get(material.baseColorTexture!.texture)!]).toEqual([255, 255, 255, 255]);
            }
            if (mode === "MASK") {
                expect(material._alphaCutOff).toBe(0.3);
            }
        }
        expect(animationGroups).toHaveLength(1);
        const group = animationGroups![0]!;
        group.loopAnimation = false;
        const factors = subjects.map((material) => material.baseColorFactor);
        const spec = computeUboLayout([
            { _name: "environmentIntensity", _type: "f32" },
            { _name: "directIntensity", _type: "f32" },
            { _name: "reflectance", _type: "f32" },
            { _name: "materialAlpha", _type: "f32" },
            { _name: "baseColorFactor", _type: "vec4<f32>" },
        ]);
        const data = new Float32Array(spec._totalBytes / 4);
        const offset = spec._offsets.get("baseColorFactor")! / 4;
        const verify = (material: PbrMaterialProps, rgb: readonly number[], alpha: number) => {
            expect(material.baseColorFactor).toBe(factors[subjects.indexOf(material)]);
            expect(material.baseColorFactor).toEqual([...rgb, 1]);
            expect(material.alpha).toBe(mode === "OPAQUE" ? undefined : alpha);
            _writeMaterialData(data, material, spec);
            expect([...data.slice(offset, offset + 4)]).toEqual([...rgb, 1]);
            expect(data[3]).toBe(mode === "OPAQUE" ? 1 : alpha);
            if (mode !== "OPAQUE") {
                expect(0.8 * data[3]! * data[offset + 3]!).toBe(0.8 * alpha);
                if (mode === "MASK") {
                    expect(0.8 * data[3]! * data[offset + 3]! < material._alphaCutOff!).toBe(0.8 * alpha < 0.3);
                }
            }
        };
        subjects.forEach((material) => verify(material, initialRgb, 0.5));
        for (const [frame, rgb, alpha] of [
            [0, initialRgb, 0.5],
            [30, initialRgb.map((value, i) => (value + [0.25, 0.5, 0.75][i]!) / 2), 0.25],
            [60, [0.25, 0.5, 0.75], 0],
            [90, [0.625, 0.75, 0.875], 0.5],
            [120, [1, 1, 1], 1],
        ] as const) {
            const versions = subjects.map((material) => material._uboVersion);
            goToFrame(group, frame);
            for (const [index, material] of subjects.entries()) {
                verify(material, rgb, alpha);
                expect(material._uboVersion).toBeGreaterThan(versions[index]!);
            }
            if (path === "variants") {
                selectVariant(container, "subject");
                for (const entry of container.materialVariants!.variants.subject!) {
                    const selected = subjects.find((material) => material === entry.mesh.material);
                    expect(selected).toBe(entry.material);
                    verify(selected!, rgb, alpha);
                }
            }
        }
        if (path === "variants") {
            resetVariant(container);
            for (const entry of container.materialVariants!.originals) {
                expect(entry.mesh.material).toBe(entry.material);
            }
        }
    });
});
