/**
 * Blocker 3 regression: a skeletal Standard mesh added AFTER the initial group
 * build (synchronous `_rebuildSingle`, which cannot dynamic-import) must still be
 * skinned. `enableStandardSkeleton()` now eagerly preloads + registers the skinning
 * ext, and the group builder awaits that preload as a backstop, so the ext is durably
 * present in the registry regardless of whether the FIRST group contained a skeletal
 * mesh. This makes skinning behave consistently (the old gated design skinned initial
 * skeletal meshes but silently bind-posed late-added ones).
 *
 * Ordering matters: the "opt-in gating" case must run BEFORE any test enables the
 * skeleton, because ext registration is a process-global that persists for the file.
 */
import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { getStandardGroupBuilder } from "../../../packages/babylon-lite/src/material/standard/standard-group-builder";
import { enableStandardSkeleton } from "../../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features";
import { _getStdExts } from "../../../packages/babylon-lite/src/material/standard/standard-flags";

const gpuGlobals = globalThis as typeof globalThis & { GPUBufferUsage?: unknown; GPUShaderStage?: unknown; GPUTextureUsage?: unknown };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8, STORAGE: 0x80 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeMockEngine(): EngineContext {
    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => d as unknown as GPURenderPipeline,
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;
    const eng = {
        canvas: {},
        msaaSamples: 1,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        format: "bgra8unorm",
        _disposables: [],
    } as unknown as EngineContext;
    Object.assign(eng, { engine: eng });
    return eng;
}

function worldAt(x: number, y: number, z: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
}

function makeStdMesh(skeleton: object | null): Mesh {
    return {
        material: createStandardMaterial(),
        worldMatrix: worldAt(0, 0, 0),
        worldMatrixVersion: 1,
        receiveShadows: false,
        morphTargets: null,
        skeleton,
        thinInstances: null,
        visible: true,
        hasVertexAlpha: false,
        _gpu: { positionBuffer: {}, normalBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint32" },
    } as unknown as Mesh;
}

// A minimal live-skeleton stand-in exposing exactly what the Standard skeleton ext
// touches: a bone texture (bind group) and joint/weight vertex buffers (draw).
function makeFakeSkeleton() {
    const jointsBuffer = { id: "joints" } as unknown as GPUBuffer;
    const weightsBuffer = { id: "weights" } as unknown as GPUBuffer;
    return {
        skeleton: { boneTexture: { createView: () => ({}) }, jointsBuffer, weightsBuffer, joints1Buffer: null, weights1Buffer: null },
        jointsBuffer,
        weightsBuffer,
    };
}

// NOTE: this describe MUST run first — it asserts the pre-opt-in state before any
// later test registers the skeleton ext globally for the file.
describe("Standard skeleton is opt-in (zero bytes / no ext until enabled)", () => {
    it("does not register the skinning ext for a group build when enableStandardSkeleton() was never called", async () => {
        expect(_getStdExts().has("std-skeleton")).toBe(false);
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = { worldMatrix: worldAt(0, 0, 0) } as never;
        // A plain non-skeletal group builds fine and pulls in NO skeleton support.
        await getStandardGroupBuilder()(scene, [makeStdMesh(null)]);
        expect(_getStdExts().has("std-skeleton")).toBe(false);
    });
});

describe("Standard late-added skeletal mesh receives skinning (durable preload seam)", () => {
    it("registers the skinning ext during an initial NON-skeletal group build, then skins a late skeletal mesh via synchronous rebuild", async () => {
        enableStandardSkeleton();

        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = { worldMatrix: worldAt(0, 0, 0) } as never;

        // Initial group contains NO skeletal mesh. The durable seam must still preload +
        // register the skinning ext (the old gated design would not, because
        // `meshes.some(isSkeletal)` was false).
        const nonSkeletal = makeStdMesh(null);
        const result = await getStandardGroupBuilder()(scene, [nonSkeletal]);
        expect(_getStdExts().has("std-skeleton")).toBe(true);

        // A skeletal mesh added AFTER registration: the synchronous rebuild (which cannot
        // import) must find the ext and produce the skinning shader + joint bindings.
        const { skeleton, jointsBuffer, weightsBuffer } = makeFakeSkeleton();
        const lateMesh = makeStdMesh(skeleton);
        const skinned = result.rebuildSingle(scene, lateMesh);

        const sig = { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus", _depthCompare: "greater", _sampleCount: 1 } as unknown as RenderTargetSignature;
        const binding = skinned.bind(engine, sig);

        // (1) Skinning shader: the vertex WGSL deforms world by the bone influence.
        const vertexWgsl = (binding.pipeline as unknown as { vertex: { module: { code: string } } }).vertex.module.code;
        expect(vertexWgsl).toContain("influence");
        expect(vertexWgsl).toContain("boneSampler");

        // (2) Joint bindings: the draw closure binds the skeleton's joint + weight buffers.
        const pass = {
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            setBindGroup: vi.fn(),
            drawIndexed: vi.fn(),
        };
        binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        const boundBuffers = pass.setVertexBuffer.mock.calls.map((c) => c[1]);
        expect(boundBuffers).toContain(jointsBuffer);
        expect(boundBuffers).toContain(weightsBuffer);
    });
});
