import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { loadGltf } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf.js";
import { collectPbrBoundTextures } from "../../../packages/babylon-lite/src/material/pbr/collect-pbr-bound-textures.js";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
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
}

function makeGlb(scenario: Scenario, path: Path): ArrayBuffer {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const imageBytes = new Uint8Array([0xab, 0x4b, 0x54, 0x58]);

    const normalOffset = positions.byteLength;
    const uvOffset = normalOffset + normals.byteLength;
    const indexOffset = uvOffset + uvs.byteLength;
    const imageOffset = align4(indexOffset + indices.byteLength);
    const binaryByteLength = imageOffset + imageBytes.byteLength;
    const binary = new Uint8Array(align4(binaryByteLength));
    binary.set(new Uint8Array(positions.buffer), 0);
    binary.set(new Uint8Array(normals.buffer), normalOffset);
    binary.set(new Uint8Array(uvs.buffer), uvOffset);
    binary.set(new Uint8Array(indices.buffer), indexOffset);
    binary.set(imageBytes, imageOffset);

    const attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
    const textures = scenario.textures.map((texture, i) => (path === "glTF sampler" && i === 0 ? { ...texture, sampler: 0 } : texture));
    const json = {
        asset: { version: "2.0" },
        extensionsUsed: [
            ...scenario.extensionsUsed,
            ...(path === "uv-transform" && !scenario.extensionsUsed.includes("KHR_texture_transform") ? ["KHR_texture_transform"] : []),
            ...(path === "variants" ? ["KHR_materials_variants"] : []),
        ],
        ...(path === "variants" ? { extensions: { KHR_materials_variants: { variants: [{ name: "subject" }] } } } : {}),
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "node", mesh: 0 }],
        meshes: [
            {
                name: "mesh",
                primitives: [
                    { attributes, indices: 3, material: 0 },
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
        ],
        accessors: [
            { bufferView: 0, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: FLOAT, count: 3, type: "VEC3" },
            { bufferView: 2, componentType: FLOAT, count: 3, type: "VEC2" },
            { bufferView: 3, componentType: UNSIGNED_SHORT, count: 3, type: "SCALAR" },
        ],
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

function makeMockEngine(): { engine: EngineContext; created: CreatedTexture[] } {
    const created: CreatedTexture[] = [];
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
        queue: { copyExternalImageToTexture: vi.fn(), writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, created };
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

async function load(scenario: Scenario, path: Path): Promise<{ subjects: PbrMaterialProps[]; factors: PbrMaterialProps[]; unowned: string[] }> {
    const { engine, created } = makeMockEngine();
    const materials = collectMaterials(await loadGltf(engine, makeGlb(scenario, path)));
    // A material's textures are acquired by its renderables and destroyed by their last release.
    // A GPU texture the loader created that no loaded material binds is unreachable from every
    // owner, so nothing ever destroys it deterministically.
    const bound = new Set(materials.flatMap((material) => collectPbrBoundTextures(material).map((texture) => texture.texture)));
    return {
        subjects: materials.filter((material) => material.name === "subject"),
        factors: materials.filter((material) => material.name === "factors"),
        unowned: created.filter(({ texture }) => !bound.has(texture)).map(({ label }) => label),
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
