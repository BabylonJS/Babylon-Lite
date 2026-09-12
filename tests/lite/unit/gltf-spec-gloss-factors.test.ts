import { describe, expect, it, vi } from "vitest";
import basisu from "../../../packages/babylon-lite/src/loader-gltf/gltf-ext-basisu";
import * as ktx2 from "../../../packages/babylon-lite/src/texture/ktx2-loader";
import { loadGltfFeatures, runGltfMaterialFeatures } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-registry";
import specGloss from "../../../packages/babylon-lite/src/loader-gltf/gltf-ext-spec-gloss";
import { assembleMaterial } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material";
import { assemblePbrProps } from "../../../packages/babylon-lite/src/loader-gltf/gltf-pbr-builder";
import { _computePbrMaterialFeatures, createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { _getPbrExts, _registerPbrExt, type PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { _writeMaterialData, buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

import { pbrExt as reflectanceExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/reflectance-fragment";
import { pbrExt as clearcoatExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/clearcoat-fragment";
import { pbrExt as iridescenceExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/iridescence-fragment";
import { registerPbrPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-bridge";
import { setPbrMetallicReflectance } from "../../../packages/babylon-lite/src/material/pbr/set-metallic-reflectance";

const composer = () =>
    createPbrComposer({
        _singleLightWGSL: "",
        _getSingleLightBlock: null,
        _multiLightWGSL: "",
        _multiLightLoop: "",
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: null,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
const texture = {} as Texture2D;

function testEngine(): EngineContext {
    return {
        _device: {
            createTexture: () => ({ createView: () => ({}) }),
            createSampler: () => ({}),
            queue: { writeTexture() {} },
        },
    } as unknown as EngineContext;
}

async function load(sg?: Record<string, unknown>) {
    const mat = await assembleMaterial(
        {
            materials: [
                {
                    pbrMetallicRoughness: { baseColorFactor: [0.7, 0.2, 0.4, 0.6], roughnessFactor: 0.4, metallicFactor: 0.7 },
                    extensions: sg ? { KHR_materials_pbrSpecularGlossiness: sg } : undefined,
                },
            ],
        },
        new DataView(new ArrayBuffer(0)),
        0,
        "",
        []
    );
    const ext = await specGloss.applyMaterial!(mat, {
        _engine: testEngine(),
        _texture: () => Promise.resolve(undefined),
        _uploadImage: () => {
            throw new Error("No image needed");
        },
    });
    return { mat, props: assemblePbrProps(mat, texture, texture, undefined, undefined, ext ?? undefined) };
}

describe("SG factor state reaches the material UBO", () => {
    it("keeps directly-created texture-only SG working without registering the glTF factor extension", async () => {
        // A registry without SG proves that legacy texture-only materials need no new preload.
        const registry = _getPbrExts() as Map<string, PbrExt>;
        registry.delete("base-spec-gloss");
        const createShaderModule = vi.fn((d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule);
        const device = {
            createBindGroupLayout: vi.fn((d) => d),
            createPipelineLayout: vi.fn((d) => d),
            createShaderModule,
            createRenderPipeline: vi.fn((d) => d),
            createBindGroup: vi.fn((d) => d),
            createSampler: vi.fn(() => ({})),
            createTexture: vi.fn(() => ({ createView: () => ({}), destroy() {} })),
            createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ destroy() {}, getMappedRange: () => new ArrayBuffer(Number(d.size)), unmap() {} })),
            queue: { writeBuffer() {}, writeTexture() {} },
        } as unknown as GPUDevice;
        const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
        Object.assign(engine, { engine });
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createPbrMaterial({
            specGlossTexture: { texture: device.createTexture({} as GPUTextureDescriptor), view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 1, height: 1 },
        });
        const mesh = { material, receiveShadows: false, morphTargets: null, worldMatrix: new Float32Array(16), worldMatrixVersion: 1, _gpu: {} } as unknown as Mesh;
        scene._groups.set(material._buildGroup, [mesh]);
        const { rebuildSingle } = await buildPbrRenderables(scene, [mesh], undefined);
        const renderable = rebuildSingle(scene, mesh);
        renderable.bind(engine, { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 });
        expect(createShaderModule).toHaveBeenCalled();
        const flags = _computePbrMaterialFeatures(material);
        const code = composer()(flags.features, flags.features2);
        expect(code._materialUboSpec!._offsets.has("specularGlossiness")).toBe(false);
        expect(_getPbrExts().has("base-spec-gloss")).toBe(false);
    });
    it("prepares only SG diffuse references and leaves MR and shared channels intact", async () => {
        const channels = { normalTexture: { index: 2 }, occlusionTexture: { index: 3 }, emissiveTexture: { index: 4 } };
        const mr = { ...channels, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } };
        const sg = { ...channels, pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, extensions: { KHR_materials_pbrSpecularGlossiness: {} } };
        const json = { materials: [mr, sg] };
        const previous = structuredClone(json);
        await specGloss.preParse!(json, new DataView(new ArrayBuffer(0)));
        expect(mr).toEqual(previous.materials[0]);
        expect(sg).toEqual({ ...channels, pbrMetallicRoughness: {}, extensions: { KHR_materials_pbrSpecularGlossiness: {} } });
    });
    it.each([false, true])("prepares SG before BasisU and keeps final diffuse selection (SG diffuse texture: %s)", async (diffuse) => {
        const json = {
            extensionsUsed: ["KHR_materials_pbrSpecularGlossiness", "KHR_texture_basisu"],
            materials: [
                {
                    pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
                    extensions: {
                        KHR_materials_pbrSpecularGlossiness: {
                            diffuseFactor: [0.3, 0.6, 0.9, 1],
                            ...(diffuse ? { diffuseTexture: { index: 1 } } : {}),
                        },
                    },
                },
            ],
            textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }, { source: 1 }],
            images: [{ uri: "mr-fallback.ktx2" }],
        };
        const bin = new DataView(new ArrayBuffer(0));
        const features = await loadGltfFeatures(json);
        expect(features.map((f) => f.id)).toEqual(["KHR_texture_basisu", "KHR_materials_pbrSpecularGlossiness"]);
        for (const feature of features) {
            await feature.preParse?.(json, bin);
        }
        await basisu.preMesh!(json, bin, "https://example.invalid/");
        const mat = await assembleMaterial(json, bin, 0, "https://example.invalid/", []);
        const fallback = {} as Texture2D;
        const selected = {} as Texture2D;
        const upload = vi.spyOn(ktx2, "uploadKtx2Texture2D").mockResolvedValue(fallback);
        const fetch = vi.fn(() => Promise.resolve(new Response(new Uint8Array(4))));
        vi.stubGlobal("fetch", fetch);
        try {
            const layers = await runGltfMaterialFeatures(mat, features, {
                _engine: testEngine(),
                _texture: (info) => Promise.resolve(info ? selected : undefined),
                _uploadImage: () => {
                    throw new Error("Unexpected image upload");
                },
            });
            expect(upload).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            expect(layers?.baseColorTexture).not.toBe(fallback);
            if (diffuse) {
                expect(layers?.baseColorTexture).toBe(selected);
            } else {
                expect(layers?.baseColorTexture).toBeUndefined();
            }
            expect(layers?.baseColorFactor).toEqual([0.3, 0.6, 0.9, 1]);
        } finally {
            upload.mockRestore();
            vi.unstubAllGlobals();
        }
    });
    it("overrides MR fallback and packs nonuniform RGB plus glossiness without quantization", async () => {
        const { mat, props } = await load({ diffuseFactor: [0.052861, 0.138432, 0.052861, 0.8], specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3 });
        expect(mat._baseColorFactor).toEqual([1, 1, 1, 1]);
        const f = _computePbrMaterialFeatures(props);
        const shader = composer()(f.features, f.features2);
        const spec = shader._materialUboSpec!;
        const data = new Float32Array(spec._totalBytes / 4);
        _writeMaterialData(data, props, spec);
        for (const [field, expected] of [
            ["baseColorFactor", [0.052861, 0.138432, 0.052861, 0.8]],
            ["specularGlossiness", [0.2, 0.5, 0.8, 0.3]],
        ] as const) {
            expect(spec._offsets.has(field)).toBe(true);
            const offset = spec._offsets.get(field)! / 4;
            expected.forEach((value, i) => expect(data[offset + i]).toBeCloseTo(value, 7));
        }
        expect(data[3]).toBe(1);
        expect(shader._meshBGLDescriptor.entries).toHaveLength(6);
    });

    it("defaults the SG factor tuple to one independently of the MR fallback", async () => {
        const { props } = await load({});
        const f = _computePbrMaterialFeatures(props);
        const spec = composer()(f.features, f.features2)._materialUboSpec!;
        expect(spec._offsets.has("specularGlossiness")).toBe(true);
        const data = new Float32Array(spec._totalBytes / 4);
        _writeMaterialData(data, props, spec);
        const offset = spec._offsets.get("specularGlossiness")! / 4;
        expect(Array.from(data.slice(offset, offset + 4))).toEqual([1, 1, 1, 1]);
    });

    it("keeps MR shader, layout and uniform values identical after SG registration", async () => {
        const registry = _getPbrExts() as Map<string, PbrExt>;
        const previous = registry.get("base-spec-gloss");
        registry.delete("base-spec-gloss");
        try {
            expect(registry.has("base-spec-gloss")).toBe(false);
            const { props } = await load();
            const f = _computePbrMaterialFeatures(props);
            const before = composer()(f.features, f.features2);
            const data = new Float32Array(before._materialUboSpec!._totalBytes / 4);
            _writeMaterialData(data, props, before._materialUboSpec!);
            await load({ specularFactor: [0.2, 0.5, 0.8] });
            expect(registry.has("base-spec-gloss")).toBe(true);
            const nextFlags = _computePbrMaterialFeatures(props);
            expect(nextFlags).toEqual(f);
            const after = composer()(nextFlags.features, nextFlags.features2);
            expect(after).toEqual(before);
            const next = new Float32Array(data.length);
            _writeMaterialData(next, props, after._materialUboSpec!);
            expect(next).toEqual(data);
        } finally {
            if (previous) {
                _registerPbrExt(previous);
            } else {
                registry.delete("base-spec-gloss");
            }
        }
    });
    it("keeps transformed reflectance layouts distinct in one composer cache", () => {
        const build = composer();
        const props = createPbrMaterial({});
        setPbrMetallicReflectance(props, { reflectanceTexture: { _hasTx: false } as unknown as Texture2D });
        const f = _computePbrMaterialFeatures(props);
        const plain = build(f.features, f.features2);
        setPbrMetallicReflectance(props, { reflectanceTexture: { _hasTx: true } as unknown as Texture2D });
        const transformedFlags = _computePbrMaterialFeatures(props);
        const transformed = build(transformedFlags.features, transformedFlags.features2);
        expect(transformed).not.toBe(plain);
        expect(plain._materialUboSpec!._offsets.has("reflUVm")).toBe(false);
        expect(transformed._materialUboSpec!._offsets.has("reflUVm")).toBe(true);
        expect(transformed._materialUboSpec!._totalBytes - plain._materialUboSpec!._totalBytes).toBe(32);
        expect(build(f.features, f.features2)).toBe(plain);
        expect(build(transformedFlags.features, transformedFlags.features2)).toBe(transformed);
    });
    it.each(["factors", "texture", "uv"])("runs MR BEFORE_LIGHTS plugins after reflectance initialization (%s)", (kind) => {
        const props = createPbrMaterial({ plugins: [{ name: "MR F0 modifier", getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_LIGHTS: "colorF0 *= 0.5;" }) }] });
        setPbrMetallicReflectance(props, kind === "factors" ? { color: [0.2, 0.4, 0.6] } : { reflectanceTexture: { _hasTx: kind === "uv" } as unknown as Texture2D });
        registerPbrPlugins(_registerPbrExt);
        const f = _computePbrMaterialFeatures(props);
        const key = composer()(f.features, f.features2, 0, 0, 0, "point", "", undefined, "", 0, props._pi)._fragmentKey.split("|");
        const initializer = key.findIndex((id) => id.startsWith(reflectanceExt.id));
        expect(initializer).toBeGreaterThanOrEqual(0);
        expect(key.indexOf(`plugin-${props._pi}`)).toBeGreaterThan(initializer);
    });
    it.each(["none", "factors", "texture", "uv"])("orders SG initializers before modifiers (reflectance: %s)", async (kind) => {
        const { props } = await load({ specularFactor: [0.2, 0.5, 0.8] });
        if (kind !== "none") {
            setPbrMetallicReflectance(props, kind === "factors" ? { color: [0.2, 0.4, 0.6] } : { reflectanceTexture: { _hasTx: kind === "uv" } as unknown as Texture2D });
        }
        _registerPbrExt(clearcoatExt);
        _registerPbrExt(iridescenceExt);
        props._clearCoat = { isEnabled: true };
        props._iridescence = { isEnabled: true };
        registerPbrPlugins(_registerPbrExt);
        props.plugins = [{ name: "shared modifier", getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_LIGHTS: "colorF0 *= 0.5;" }) }];
        const f = _computePbrMaterialFeatures(props);
        const key = composer()(f.features, f.features2, 0, 0, 0, "point", "", undefined, "", 0, props._pi)._fragmentKey.split("|");
        const sgIndex = key.indexOf("base-spec-gloss");
        expect(sgIndex).toBeGreaterThanOrEqual(0);
        if (kind !== "none") {
            expect(key.indexOf(reflectanceExt.id)).toBeGreaterThanOrEqual(0);
            expect(key.indexOf(reflectanceExt.id)).toBeLessThan(sgIndex);
        }
        for (const modifier of ["clearcoat", "iridescence", "plugin-"]) {
            expect(key.findIndex((id) => id.startsWith(modifier))).toBeGreaterThan(sgIndex);
        }
        // The exact same cached plugin signature must remain usable on MR.
        const mr = { ...props, _specularGlossiness: undefined, _clearCoat: undefined, _iridescence: undefined };
        const mrFlags = _computePbrMaterialFeatures(mr);
        expect(mr._pi).toBe(props._pi);
        const mrCode = composer()(mrFlags.features, mrFlags.features2, 0, 0, 0, "point", "", undefined, "", 0, mr._pi);
        expect(mrCode._fragmentKey.split("|")).not.toContain("base-spec-gloss");
    });
});
