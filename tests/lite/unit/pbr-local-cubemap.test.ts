import { describe, expect, it, vi } from "vitest";

import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";
import {
    createPbrLocalEnvironmentProbeSet,
    enablePbrLocalCubemap,
    getPbrLocalEnvironmentProbeGridCell,
    MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES,
    MAX_PBR_LOCAL_ENVIRONMENT_PROBES,
    setPbrEnvironment,
    setPbrLocalEnvironment,
    setPbrLocalEnvironmentProbeDebug,
    setPbrLocalEnvironmentProbeSet,
    type PbrLocalEnvironmentProbeSet,
} from "../../../packages/babylon-lite/src/material/pbr/enable-pbr-local-cubemap";
import { pbrExt as clearcoatExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/clearcoat-fragment";
import { pbrExt as iblExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { pbrExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/local-cubemap-fragment";
import { pbrExt as sheenExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/sheen-fragment";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { _registerPbrExt, PBR_HAS_ENV } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _computePbrMaterialFeatures, createPbrMaterial, type PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createPbrMeshBindGroup } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";

function makeEnvironment(overrides: Partial<EnvironmentTextures> = {}): EnvironmentTextures {
    return overrides as EnvironmentTextures;
}

function composer() {
    return createPbrComposer({
        _singleLightWGSL: "",
        _getSingleLightBlock: null,
        _multiLightWGSL: "",
        _multiLightLoop: "",
        _toneMappingHelpers: "",
        _toneMappingCall: "",
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: null,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
}

function fakeProbeSet(environment: EnvironmentTextures): PbrLocalEnvironmentProbeSet {
    return {
        probes: [
            {
                environment,
                capturePosition: [0, 0, 0],
                projectionPosition: [0, 0, 0],
                projectionSize: [4, 4, 4],
                influencePosition: [0, 0, 0],
                influenceInnerSize: [2, 2, 2],
                influenceOuterSize: [6, 6, 6],
            },
        ],
        _uniformBuffer: {} as GPUBuffer,
        _uniformData: new Float32Array(),
        _uniformU32: new Uint32Array(),
        _texture: {} as GPUTexture,
        _textureView: {} as GPUTextureView,
        _sampler: {} as GPUSampler,
        _gridBuffer: {} as GPUBuffer,
        _gridData: new Uint32Array([0, 0, 0, 0, 1, 1, 1, 7, 1, 0, 0, 0, 0, 0, 0]),
        _gridMinimum: [0, 0, 0],
        _gridCellSize: 1,
        _gridDimensions: [1, 1, 1],
        _gridStride: 7,
        _engine: {} as never,
        _device: {} as GPUDevice,
        _ensureDevice: vi.fn(),
    };
}

function makeProbeGridTestScene(): { scene: unknown; environment: EnvironmentTextures; device: GPUDevice } {
    const destinationTexture = {
        createView: vi.fn(() => ({}) as GPUTextureView),
        destroy: vi.fn(),
    } as unknown as GPUTexture;
    const device = {
        limits: {
            maxTextureArrayLayers: 256,
            maxUniformBufferBindingSize: 65536,
            maxStorageBufferBindingSize: 65536,
            maxBufferSize: 65536,
        },
        createTexture: vi.fn(() => destinationTexture),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return {
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => mapped),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            copyTextureToTexture: vi.fn(),
            finish: () => ({}),
        })),
        queue: {
            submit: vi.fn(),
            writeBuffer: vi.fn(),
        },
    } as unknown as GPUDevice;
    const environment = makeEnvironment({
        specularCube: {
            width: 64,
            height: 64,
            depthOrArrayLayers: 6,
            mipLevelCount: 7,
            format: "rgba16float",
        } as GPUTexture,
        cubeSampler: {} as GPUSampler,
    });
    return {
        scene: {
            surface: { engine: { _device: device } },
            _disposables: [],
        },
        environment,
        device,
    };
}

describe("PBR local cubemap projection", () => {
    it("defaults to four candidates and locks a custom value during initialization", async () => {
        expect(MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES).toBe(4);
        expect(MAX_PBR_LOCAL_ENVIRONMENT_PROBES).toBe(585);
        expect(() => enablePbrLocalCubemap({ maxCandidates: 0 })).toThrow(/integer from 1 to 12/);

        await enablePbrLocalCubemap({ maxCandidates: 6 });

        expect(MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES).toBe(6);
        await expect(enablePbrLocalCubemap()).resolves.toBeUndefined();
        expect(() => enablePbrLocalCubemap({ maxCandidates: 5 })).toThrow(/already 6/);
    });

    it("keeps single local cubemaps independent from sheen roughness textures", () => {
        const material = createPbrMaterial();
        setPbrLocalEnvironment(material, makeEnvironment(), {
            projectionPosition: [0, 0, 0],
            projectionSize: [1, 1, 1],
        });
        material._sheen = {
            isEnabled: true,
            roughnessTexture: {} as never,
        };

        expect(pbrExt.detect!(material)).toEqual({ f: 1 << 31, f2: 0 });
        expect(sheenExt.detect!(material).f2 & (1 << 31)).not.toBe(0);
    });

    it("overrides one material environment without parallax projection", () => {
        const material = createPbrMaterial();
        setPbrEnvironment(
            material,
            makeEnvironment({
                sphericalHarmonics: new Float32Array(36),
                lodGenerationScale: 0.7,
            })
        );

        expect(pbrExt.detect!(material)).toEqual({ f: 1 << 31, f2: 0 });
        const features = _computePbrMaterialFeatures(material);
        const result = composer()(features.features, features.features2, 0, 0);
        const data = new Float32Array(1);

        pbrExt.writeUbo!(data, material, new Map([["localEnvironmentMode", 0]]));

        expect(data[0]).toBe(1);
        expect(result._fragmentWGSL).toContain("localSingleReflectionDirection");
        expect(result._fragmentWGSL).toContain("material.localEnvironmentMode");
    });

    it("keeps the lightweight single-probe box projection path", async () => {
        const globalCubeView = {} as GPUTextureView;
        const localCubeView = {} as GPUTextureView;
        const localSampler = {} as GPUSampler;
        const globalEnvironment = makeEnvironment({
            brdfLutView: {} as GPUTextureView,
            brdfSampler: {} as GPUSampler,
            specularCubeView: globalCubeView,
            cubeSampler: {} as GPUSampler,
        });
        const localEnvironment = makeEnvironment({
            brdfLutView: {} as GPUTextureView,
            brdfSampler: {} as GPUSampler,
            specularCube: { createView: vi.fn(() => ({})) } as unknown as GPUTexture,
            specularCubeView: localCubeView,
            cubeSampler: localSampler,
            lodGenerationScale: 0.7,
        });
        const material = {
            baseColorTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
            ormTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
        } as PbrMaterialProps;
        setPbrLocalEnvironment(material, localEnvironment, {
            projectionPosition: [1, 2, 3],
            projectionSize: [4, 5, 6],
        });
        let descriptor: GPUBindGroupDescriptor | undefined;
        const createdBufferSizes: number[] = [];
        const engine = {
            _device: {
                createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
                    createdBufferSizes.push(Number(descriptor.size));
                    const data = new ArrayBuffer(Number(descriptor.size));
                    return {
                        getMappedRange: () => data,
                        unmap: vi.fn(),
                    } as unknown as GPUBuffer;
                },
                queue: { writeBuffer: vi.fn() },
                createBindGroup(value: GPUBindGroupDescriptor): GPUBindGroup {
                    descriptor = value;
                    return {} as GPUBindGroup;
                },
            },
        };

        _registerPbrExt(iblExt);
        await enablePbrLocalCubemap();
        createPbrMeshBindGroup(
            engine as never,
            { _features: 1 << 31, _features2: 0, _meshFeatures: 0, _meshBGL: {} as GPUBindGroupLayout, _shadowBGL: null } as never,
            { _fragmentKey: "ibl|local-cubemap" } as never,
            {} as GPUBuffer,
            {} as GPUBuffer,
            material,
            globalEnvironment,
            null
        );

        const resources = Array.from(descriptor!.entries, (entry) => entry.resource);
        expect(resources).toContain(localCubeView);
        expect(resources).toContain(localSampler);
        expect(resources).not.toContain(globalCubeView);
        expect(createdBufferSizes.every((size) => size % 16 === 0)).toBe(true);
    });

    it("writes single-probe projection, LOD, and spherical harmonics to the material UBO", () => {
        const sphericalHarmonics = Float32Array.from({ length: 36 }, (_, index) => index + 1);
        const material = {} as PbrMaterialProps;
        setPbrLocalEnvironment(
            material,
            makeEnvironment({
                sphericalHarmonics: sphericalHarmonics,
                lodGenerationScale: 0.65,
            }),
            {
                capturePosition: [7, 8, 9],
                projectionPosition: [1, 2, 3],
                projectionSize: [4, 5, 6],
            }
        );
        const data = new Float32Array(28);
        const offsets = new Map<string, number>([
            ["localSphericalL00", 0],
            ["localSphericalL1_1", 16],
            ["localSphericalL22", 32],
            ["vReflectionPosition", 48],
            ["vReflectionSize", 64],
            ["localLodGenerationScale", 80],
            ["vReflectionCapturePosition", 96],
            ["localEnvironmentMode", 108],
        ]);

        pbrExt.writeUbo!(data, material, offsets);

        expect(Array.from(data.slice(0, 3))).toEqual([1, 2, 3]);
        expect(Array.from(data.slice(4, 7))).toEqual([5, 6, 7]);
        expect(Array.from(data.slice(8, 11))).toEqual([33, 34, 35]);
        expect(Array.from(data.slice(12, 15))).toEqual([1, 2, 3]);
        expect(Array.from(data.slice(16, 19))).toEqual([4, 5, 6]);
        expect(data[20]).toBeCloseTo(0.65);
        expect(Array.from(data.slice(24, 27))).toEqual([7, 8, 9]);
        expect(data[27]).toBe(2);
    });

    it("writes spherical single-probe projection data to the material UBO", () => {
        const material = {} as PbrMaterialProps;
        setPbrLocalEnvironment(material, makeEnvironment({ sphericalHarmonics: new Float32Array(36) }), {
            shape: "sphere",
            projectionPosition: [1, 2, 3],
            projectionRadius: 7,
        });
        const data = new Float32Array(9);
        const offsets = new Map<string, number>([
            ["vReflectionPosition", 0],
            ["vReflectionSize", 16],
            ["localEnvironmentMode", 32],
        ]);

        pbrExt.writeUbo!(data, material, offsets);

        expect(Array.from(data.slice(0, 3))).toEqual([1, 2, 3]);
        expect(Array.from(data.slice(4, 7))).toEqual([14, 14, 14]);
        expect(data[8]).toBe(3);
        expect(pbrExt.detect!(material)).toEqual({ f: 1 << 31, f2: 0 });
    });

    it("supplies complete local IBL without adding fields to ordinary PBR materials", async () => {
        const environment = makeEnvironment({
            brdfLutView: {} as GPUTextureView,
            brdfSampler: {} as GPUSampler,
            specularCubeView: {} as GPUTextureView,
            cubeSampler: {} as GPUSampler,
            sphericalHarmonics: new Float32Array(36),
            lodGenerationScale: 0.8,
        });
        const material = {
            baseColorTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
            ormTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
        } as PbrMaterialProps;
        setPbrLocalEnvironment(material, environment, {
            projectionPosition: [1, 2, 3],
            projectionSize: [4, 5, 6],
        });

        const features = _computePbrMaterialFeatures(material);
        const result = composer()(features.features, features.features2, 0, 0);

        expect(material).not.toHaveProperty("localEnvironment");
        expect(result._fragmentKey).toContain("local-cubemap");
        expect(result._fragmentWGSL).toContain("var brdfLUT:texture_2d<f32>");
        expect(result._fragmentWGSL).toContain("material.localSphericalL00");
        expect(result._fragmentWGSL).toContain("localSingleReflectionDirection(input.worldPos,R_raw");
    });

    it("binds one cube array, one sampler, and one shared UBO for every local probe", async () => {
        const environment = makeEnvironment({
            brdfLutView: {} as GPUTextureView,
            brdfSampler: {} as GPUSampler,
            specularCubeView: {} as GPUTextureView,
            cubeSampler: {} as GPUSampler,
        });
        const set = fakeProbeSet(environment);
        const material = {
            baseColorTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
            ormTexture: { view: {} as GPUTextureView, sampler: {} as GPUSampler },
        } as PbrMaterialProps;
        setPbrLocalEnvironmentProbeSet(material, set);
        let descriptor: GPUBindGroupDescriptor | undefined;
        const engine = {
            _device: {
                createBindGroup(value: GPUBindGroupDescriptor): GPUBindGroup {
                    descriptor = value;
                    return {} as GPUBindGroup;
                },
            },
        };

        _registerPbrExt(iblExt);
        await enablePbrLocalCubemap();
        const features = _computePbrMaterialFeatures(material);
        createPbrMeshBindGroup(
            engine as never,
            { _features: features.features, _features2: features.features2, _meshFeatures: 0, _meshBGL: {} as GPUBindGroupLayout, _shadowBGL: null } as never,
            { _fragmentKey: "ibl|local-cubemap" } as never,
            {} as GPUBuffer,
            {} as GPUBuffer,
            material,
            environment,
            null
        );

        const resources = Array.from(descriptor!.entries, (entry) => entry.resource);
        expect(resources).toContainEqual({ buffer: set._uniformBuffer });
        expect(resources).toContainEqual({ buffer: set._gridBuffer });
        expect(resources).toContain(set._textureView);
        expect(resources).toContain(set._sampler);
        expect(resources).toContain(environment.specularCubeView);
    });

    it("composes per-fragment oriented box weights without replacing scene irradiance", async () => {
        _registerPbrExt(iblExt);
        _registerPbrExt(clearcoatExt);
        _registerPbrExt(sheenExt);
        await enablePbrLocalCubemap();
        const environment = makeEnvironment({});
        const material = createPbrMaterial({
            _clearCoat: { isEnabled: true },
            _sheen: { isEnabled: true },
        });
        setPbrLocalEnvironmentProbeSet(material, fakeProbeSet(environment));
        const features = _computePbrMaterialFeatures(material);
        const result = composer()(features.features | clearcoatExt.detect!(material).f | sheenExt.detect!(material).f, features.features2, 0, PBR_HAS_ENV);

        expect(result._fragmentWGSL).toContain("var localProbeTexture:texture_cube_array<f32>");
        expect(result._fragmentWGSL).toContain("probes:array<LocalEnvironmentProbe,585>");
        expect(result._fragmentWGSL).toContain("var<storage, read> localProbeGrid:localProbeGridUniforms");
        expect(result._fragmentWGSL).toContain("fn localProbeVoxelBase(worldPos:vec3f)");
        expect(result._fragmentWGSL).toContain("let candidateCount=min(localProbeGrid.indices[voxelBase],6u);");
        expect(result._fragmentWGSL).toContain("var ndfs:array<f32,6>");
        expect(result._fragmentWGSL).toContain("fn probeNdf(");
        expect(result._fragmentWGSL).toContain("let axisNdf=(abs(localPosition)-innerExtent)/span;");
        expect(result._fragmentWGSL).toContain("fn localProbeIsSphere(");
        expect(result._fragmentWGSL).toContain("return (length(localPosition)-innerExtent.x)");
        expect(result._fragmentWGSL).toContain("let determinant=b*b-a*(dot(localPos,localPos)-radius*radius);");
        expect(result._fragmentWGSL).toContain("if(determinant<0.0){return worldRay;}");
        expect(result._fragmentWGSL).toContain("var nearestProbeIndex=voxelProbeIndex(voxelBase,0u);");
        expect(result._fragmentWGSL).toContain("return sampleOneLocalProbe(nearestProbeIndex");
        expect(result._fragmentWGSL).toContain("let boundaryWeight=(1.0-ndf/max(sumNdf,0.00001))/countMinusOne;");
        expect(result._fragmentWGSL).toContain("probeToLocal(worldPos-probe.influenceCentreAndCos.xyz");
        expect(result._fragmentWGSL).toContain("fn localProbeDebugColor(");
        expect(result._fragmentWGSL).toContain("let localProbeDebugOutput=environmentRadiance;");
        expect(result._fragmentWGSL).toContain("color=localProbeDebugOutput;");
        expect(result._fragmentWGSL).toContain("sampleLocalProbeRadiance(input.worldPos,ccR_raw");
        expect(result._fragmentWGSL).toContain("sampleLocalProbeRadiance(input.worldPos,R_raw,shAlphaG_ibl");
        expect(result._fragmentWGSL).toContain("let sceneEnvironmentIrradiance = (scene.vSphericalL00.rgb");
        expect(result._fragmentWGSL).toContain("let environmentIrradiance=select(localEnvironmentIrradiance,sceneEnvironmentIrradiance");
        expect(result._fragmentWGSL).toContain("var iblTexture:texture_cube<f32>");
        expect(result._meshBGLDescriptor.entries).toContainEqual(expect.objectContaining({ buffer: { type: "read-only-storage" } }));
    });

    it("composes probe-array IBL without a global scene environment", async () => {
        _registerPbrExt(clearcoatExt);
        _registerPbrExt(sheenExt);
        const environment = makeEnvironment({ sphericalHarmonics: new Float32Array(36) });
        const material = createPbrMaterial({
            _clearCoat: { isEnabled: true },
            _sheen: { isEnabled: true },
        });
        setPbrLocalEnvironmentProbeSet(material, fakeProbeSet(environment));

        const features = _computePbrMaterialFeatures(material);
        const result = composer()(features.features, features.features2, 0, 0);

        expect(result._fragmentWGSL).toContain("var brdfLUT:texture_2d<f32>");
        expect(result._fragmentWGSL).toContain("material.localSphericalL00");
        expect(result._fragmentWGSL).toContain("var localProbeTexture:texture_cube_array<f32>");
        expect(result._fragmentWGSL).toContain("var iblTexture:texture_cube<f32>");
        expect(result._fragmentWGSL).toContain("sampleLocalProbeRadiance(input.worldPos,ccR_raw");
        expect(result._fragmentWGSL).toContain("sampleLocalProbeRadiance(input.worldPos,R_raw,shAlphaG_ibl");
        expect(result._fragmentKey).toContain("local-cubemap");
    });

    it("normalizes mixed-resolution cubemaps through matching source mip copies", () => {
        const copies: Array<{ sourceMip: number; sourceLayer: number; destinationLayer: number; size: readonly number[] }> = [];
        const writes: Float32Array[] = [];
        const destinationTexture = {
            width: 512,
            height: 512,
            depthOrArrayLayers: 12,
            mipLevelCount: 10,
            format: "rgba16float",
            createView: vi.fn(() => ({ id: "cube-array-view" })),
            destroy: vi.fn(),
        } as unknown as GPUTexture;
        const uniformBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
        const gridMapped = new ArrayBuffer(64 * 1024);
        const gridBuffer = {
            destroy: vi.fn(),
            getMappedRange: vi.fn(() => gridMapped),
            unmap: vi.fn(),
        } as unknown as GPUBuffer;
        const device = {
            limits: {
                maxTextureArrayLayers: 256,
                maxUniformBufferBindingSize: 65536,
                maxStorageBufferBindingSize: 65536,
                maxBufferSize: 65536,
            },
            createTexture: vi.fn(() => destinationTexture),
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => (descriptor.mappedAtCreation ? gridBuffer : uniformBuffer)),
            createCommandEncoder: vi.fn(() => ({
                copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, size: GPUExtent3DStrict) {
                    const sourceOrigin = source.origin as readonly number[];
                    const destinationOrigin = destination.origin as readonly number[];
                    copies.push({
                        sourceMip: source.mipLevel ?? 0,
                        sourceLayer: sourceOrigin[2]!,
                        destinationLayer: destinationOrigin[2]!,
                        size: size as readonly number[],
                    });
                },
                finish: () => ({}),
            })),
            queue: {
                submit: vi.fn(),
                writeBuffer: vi.fn((_buffer, _offset, source: ArrayBuffer, byteOffset: number, byteLength: number) => {
                    writes.push(new Float32Array(source.slice(byteOffset, byteOffset + byteLength)));
                }),
            },
        } as unknown as GPUDevice;
        const source = (width: number, mipLevelCount: number) =>
            ({
                width,
                height: width,
                depthOrArrayLayers: 6,
                mipLevelCount,
                format: "rgba16float",
            }) as GPUTexture;
        const environment = (width: number, mipLevelCount: number) =>
            makeEnvironment({
                specularCube: source(width, mipLevelCount),
                cubeSampler: {} as GPUSampler,
                lodGenerationScale: 0.8,
            });
        const scene = {
            surface: { engine: { _device: device } },
            _disposables: [],
        };

        const set = createPbrLocalEnvironmentProbeSet(scene as never, {
            probes: [
                {
                    environment: environment(1024, 11),
                    capturePosition: [1, 2, 3],
                    projectionPosition: [4, 5, 6],
                    projectionSize: [8, 10, 12],
                    influencePosition: [7, 8, 9],
                    influenceInnerSize: [2, 4, 6],
                    influenceOuterPosition: [10, 8, 9],
                    influenceOuterSize: [10, 12, 14],
                    angleRadians: Math.PI / 2,
                    debugColor: [0.2, 0.4, 0.6],
                },
                {
                    environment: environment(512, 10),
                    shape: "sphere",
                    capturePosition: [0, 0, 0],
                    projectionPosition: [0, 0, 0],
                    projectionRadius: 2,
                    influencePosition: [0, 0, 0],
                    influenceInnerRadius: 1,
                    influenceOuterRadius: 3,
                },
            ],
            voxelGrid: {
                minimum: [-8, -8, -8],
                maximum: [8, 8, 8],
                cellSize: 4,
            },
        });

        expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: [512, 512, 12], mipLevelCount: 10, format: "rgba16float" }));
        expect(copies[0]).toEqual({ sourceMip: 1, sourceLayer: 0, destinationLayer: 0, size: [512, 512, 1] });
        expect(copies.find((copy) => copy.destinationLayer === 6)).toMatchObject({ sourceMip: 0, sourceLayer: 0 });
        expect(set._uniformU32.slice(0, 4)).toEqual(new Uint32Array([2, 0, 0, 1]));
        expect(set._uniformData[4 + 15]).toBeCloseTo(0);
        expect(set._uniformData[4 + 19]).toBeCloseTo(1);
        expect(set._uniformData[4 + 11]).toBeCloseTo(-0.2);
        expect(Array.from(set._uniformData.slice(4 + 20, 4 + 23))).toEqual([10, 8, 9]);
        expect(Array.from(set._uniformData.slice(4 + 24, 4 + 27))).toEqual([5, 6, 7]);
        expect(set._uniformU32[4 + 27]).toBe(0x996633);
        expect(set._uniformU32[4 + 28 + 27]).toBe(0x01ff00ff);
        expect(device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: 65536, usage: expect.any(Number) }));
        expect(device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ mappedAtCreation: true }));
        expect(writes).toHaveLength(1);
        expect(writes[0]).toHaveLength(16384);

        const centreCell = getPbrLocalEnvironmentProbeGridCell(set, [0, 0, 0]);
        expect(centreCell.coordinates).toEqual([2, 2, 2]);
        expect(centreCell.probeIndices).toEqual([1]);
        expect(centreCell.outside).toBe(false);
        const outsideCell = getPbrLocalEnvironmentProbeGridCell(set, [100, 0, 0]);
        expect(outsideCell.coordinates).toEqual([3, 2, 2]);
        expect(outsideCell.outside).toBe(true);

        setPbrLocalEnvironmentProbeDebug(set, true);
        expect(set._uniformU32[3]).toBe(3);
        expect(writes).toHaveLength(2);
        expect(writes[1]).toHaveLength(1);

        setPbrLocalEnvironmentProbeDebug(set, true);
        expect(writes).toHaveLength(2);

        setPbrLocalEnvironmentProbeDebug(set, false);
        expect(set._uniformU32[3]).toBe(1);
        expect(writes).toHaveLength(3);
    });

    it("voxelizes yaw-oriented outer boxes and fills empty cells with a nearest fallback", () => {
        const { scene, environment } = makeProbeGridTestScene();
        const set = createPbrLocalEnvironmentProbeSet(scene as never, {
            probes: [
                {
                    environment,
                    capturePosition: [0, 0, 0],
                    projectionPosition: [0, 0, 0],
                    projectionSize: [2, 2, 6],
                    influencePosition: [0, 0, 0],
                    influenceInnerSize: [1, 1, 5],
                    influenceOuterSize: [2, 2, 6],
                    angleRadians: Math.PI / 2,
                },
                {
                    environment,
                    capturePosition: [3, 0, 0],
                    projectionPosition: [3, 0, 0],
                    projectionSize: [1, 1, 1],
                    influencePosition: [3, 0, 0],
                    influenceInnerSize: [0.25, 0.25, 0.25],
                    influenceOuterSize: [0.5, 0.5, 0.5],
                },
            ],
            voxelGrid: {
                minimum: [-4, -2, -4],
                maximum: [4, 2, 4],
                cellSize: 2,
            },
        });

        expect(getPbrLocalEnvironmentProbeGridCell(set, [3, 0, 0]).probeIndices).toEqual([0, 1]);
        expect(getPbrLocalEnvironmentProbeGridCell(set, [-3, 0, 3]).probeIndices).toEqual([0]);
    });

    it("voxelizes spherical outer influence with exact sphere-to-cell intersections", () => {
        const { scene, environment } = makeProbeGridTestScene();
        const set = createPbrLocalEnvironmentProbeSet(scene as never, {
            probes: [
                {
                    environment,
                    shape: "sphere",
                    capturePosition: [0, 0, 0],
                    projectionPosition: [0, 0, 0],
                    projectionRadius: 1,
                    influencePosition: [0, 0, 0],
                    influenceInnerRadius: 0,
                    influenceOuterRadius: 1,
                },
                {
                    environment,
                    capturePosition: [0, 0, 0],
                    projectionPosition: [0, 0, 0],
                    projectionSize: [4, 4, 4],
                    influencePosition: [0, 0, 0],
                    influenceInnerSize: [0, 0, 0],
                    influenceOuterSize: [4, 4, 4],
                },
            ],
            voxelGrid: {
                minimum: [-2, -2, -2],
                maximum: [2, 2, 2],
                cellSize: 1,
            },
        });

        expect(getPbrLocalEnvironmentProbeGridCell(set, [0.5, 0.5, 0.5]).probeIndices).toEqual([0, 1]);
        expect(getPbrLocalEnvironmentProbeGridCell(set, [1.5, 1.5, 0.5]).probeIndices).toEqual([1]);
    });

    it("rejects oversized voxel grids before allocating their cells", () => {
        const { scene, environment } = makeProbeGridTestScene();

        expect(() =>
            createPbrLocalEnvironmentProbeSet(scene as never, {
                probes: [
                    {
                        environment,
                        capturePosition: [0, 0, 0],
                        projectionPosition: [0, 0, 0],
                        projectionSize: [1, 1, 1],
                        influencePosition: [0, 0, 0],
                        influenceInnerSize: [0, 0, 0],
                        influenceOuterSize: [1, 1, 1],
                    },
                ],
                voxelGrid: {
                    minimum: [0, 0, 0],
                    maximum: [10_000, 10_000, 10_000],
                    cellSize: 1,
                },
            })
        ).toThrow(/voxel grid requires .* exceeding this device's storage-buffer limits/);
    });

    it("recreates probe resources when the engine device changes", () => {
        const { scene, environment, device } = makeProbeGridTestScene();
        const set = createPbrLocalEnvironmentProbeSet(scene as never, {
            probes: [
                {
                    environment,
                    capturePosition: [0, 0, 0],
                    projectionPosition: [0, 0, 0],
                    projectionSize: [2, 2, 2],
                    influencePosition: [0, 0, 0],
                    influenceInnerSize: [1, 1, 1],
                    influenceOuterSize: [2, 2, 2],
                },
            ],
            voxelGrid: {
                minimum: [-1, -1, -1],
                maximum: [1, 1, 1],
                cellSize: 2,
            },
        });
        const recovered = makeProbeGridTestScene();

        expect(set._device).toBe(device);
        (scene as { surface: { engine: { _device: GPUDevice } } }).surface.engine._device = recovered.device;
        setPbrLocalEnvironmentProbeDebug(set, true);

        expect(set._device).toBe(recovered.device);
        expect(recovered.device.createTexture).toHaveBeenCalledOnce();
        expect(recovered.device.createBuffer).toHaveBeenCalledTimes(2);
        expect(recovered.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    });

    it("rejects invalid spherical projection and influence radii", () => {
        const { scene, environment } = makeProbeGridTestScene();
        const probe = {
            environment,
            shape: "sphere" as const,
            capturePosition: [0, 0, 0] as const,
            projectionPosition: [0, 0, 0] as const,
            projectionRadius: 2,
            influencePosition: [0, 0, 0] as const,
            influenceInnerRadius: 3,
            influenceOuterRadius: 2,
        };

        expect(() =>
            createPbrLocalEnvironmentProbeSet(scene as never, {
                probes: [probe],
                voxelGrid: { minimum: [-2, -2, -2], maximum: [2, 2, 2], cellSize: 1 },
            })
        ).toThrow(/influenceInnerRadius/);
        expect(() =>
            setPbrLocalEnvironment({} as PbrMaterialProps, environment, {
                shape: "sphere",
                projectionPosition: [0, 0, 0],
                projectionRadius: 0,
            })
        ).toThrow(/projectionRadius/);
    });

    it("fails explicitly when one voxel intersects more probes than maxCandidates", () => {
        const { scene, environment } = makeProbeGridTestScene();
        const probe = {
            environment,
            capturePosition: [0, 0, 0] as const,
            projectionPosition: [0, 0, 0] as const,
            projectionSize: [4, 4, 4] as const,
            influencePosition: [0, 0, 0] as const,
            influenceInnerSize: [2, 2, 2] as const,
            influenceOuterSize: [4, 4, 4] as const,
        };

        expect(() =>
            createPbrLocalEnvironmentProbeSet(scene as never, {
                probes: Array.from({ length: MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES + 1 }, () => probe),
                voxelGrid: {
                    minimum: [-1, -1, -1],
                    maximum: [1, 1, 1],
                    cellSize: 2,
                },
            })
        ).toThrow(`exceeding maxCandidates ${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}`);
    });
});
