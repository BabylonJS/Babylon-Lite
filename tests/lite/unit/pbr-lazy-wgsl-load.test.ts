import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { _computeMeshFeatures } from "../../../packages/babylon-lite/src/material/mesh-features";
import { _pbrLazyWgslNeeds } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { PBR_HAS_NORMAL_MAP, PBR_HAS_SPEC_GLOSS } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import { _registerPbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _computePbrMaterialFeatures, createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { _lazyPbrCaps, buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

// Distinctive WGSL from each lazily loaded module.
const TANGENT_MARKER = "let normalMapNorm=";
const COTANGENT_MARKER = "cotangentFrame";
const SPEC_GLOSS_MARKER = "let specGloss=textureSample(specGlossTexture";

const texture = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler } as Texture2D;
const signature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 } as RenderTargetSignature;

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({}) as GPUTextureView), destroy: vi.fn() }) as unknown as GPUTexture),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return { destroy: vi.fn(), getMappedRange: vi.fn(() => storage), unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, createShaderModule };
}

function makeMesh(material: PbrMaterialProps, hasTangents: boolean): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material,
        receiveShadows: false,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        _gpu: hasTangents ? { tangentBuffer: {} } : {},
    } as unknown as Mesh;
}

/** Build one PBR group containing `mesh` and return the fragment WGSL it composed. */
async function composedFragment(mesh: Mesh): Promise<string> {
    const { engine, createShaderModule } = makeEngine();
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene._groups.set(mesh.material!._buildGroup, [mesh]);
    const result = await buildPbrRenderables(scene, [mesh], undefined);
    result.renderables[0]!.bind(engine, signature);
    const fragments = createShaderModule.mock.calls.map((call) => (call[0] as GPUShaderModuleDescriptor).code).filter((code) => code.includes("@fragment fn main"));
    expect(fragments).toHaveLength(1);
    return fragments[0]!;
}

describe("lazy PBR WGSL loading", () => {
    beforeEach(() => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
    });

    it("loads the tangent-frame normal-map module for a normal-mapped mesh with tangents", async () => {
        const fragment = await composedFragment(makeMesh(createPbrMaterial({ normalTexture: texture }), true));
        expect(fragment).toContain(TANGENT_MARKER);
        expect(fragment).not.toContain(COTANGENT_MARKER);
    });

    it("loads the cotangent normal-map module for a normal-mapped mesh without tangents", async () => {
        const fragment = await composedFragment(makeMesh(createPbrMaterial({ normalTexture: texture }), false));
        expect(fragment).toContain(COTANGENT_MARKER);
        expect(fragment).not.toContain(TANGENT_MARKER);
    });

    it("loads the specular-glossiness module for a spec-gloss material", async () => {
        const fragment = await composedFragment(makeMesh(createPbrMaterial({ specGlossTexture: texture }), false));
        expect(fragment).toContain(SPEC_GLOSS_MARKER);
    });

    it("loads none of them for a plain metallic-roughness material", async () => {
        const fragment = await composedFragment(makeMesh(createPbrMaterial(), true));
        for (const marker of [TANGENT_MARKER, COTANGENT_MARKER, SPEC_GLOSS_MARKER]) {
            expect(fragment).not.toContain(marker);
        }
    });

    it("derives the loaded modules from the feature bits composition reads, extension detect bits included", () => {
        // An extension that raises the normal-map / spec-gloss bits through `detect` alone, with no texture
        // on the material: the build must still load what composition will ask for.
        _registerPbrExt({
            id: "test-lazy-wgsl-detect",
            phase: "fragment",
            detect: (mat) => {
                const forced = (mat as { _testForcedBits?: number })._testForcedBits ?? 0;
                return { f: forced, f2: 0 };
            },
        });
        const variants: Partial<PbrMaterialProps & { _testForcedBits: number }>[] = [
            {},
            { normalTexture: texture },
            { specGlossTexture: texture },
            { normalTexture: texture, specGlossTexture: texture },
            { _testForcedBits: PBR_HAS_NORMAL_MAP },
            { _testForcedBits: PBR_HAS_SPEC_GLOSS },
            { _testForcedBits: PBR_HAS_NORMAL_MAP | PBR_HAS_SPEC_GLOSS },
        ];
        for (const props of variants) {
            for (const hasTangents of [false, true]) {
                const material = Object.assign(createPbrMaterial(), props);
                const mesh = makeMesh(material, hasTangents);
                const composed = _pbrLazyWgslNeeds(_computePbrMaterialFeatures(material).features, _computeMeshFeatures(mesh));
                expect({ props: Object.keys(props), hasTangents, loaded: _lazyPbrCaps(mesh) & ~1 }).toEqual({ props: Object.keys(props), hasTangents, loaded: composed });
            }
        }
    });
});
