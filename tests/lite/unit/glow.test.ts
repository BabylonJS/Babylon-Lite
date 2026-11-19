import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { buildRenderTarget, createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createGlowPostProcessTask } from "../../../packages/babylon-lite/src/post-process/glow";
import { markMaterialUboDirty } from "../../../packages/babylon-lite/src/material/material-dirty";
import { getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import { packMat4IntoF32 } from "../../../packages/babylon-lite/src/math/pack-mat4-into-f32";
import { SCENE_UBO_BYTES } from "../../../packages/babylon-lite/src/shader/scene-uniforms-size";
import { parseNodeMaterialFromSnippet } from "../../../packages/babylon-lite/src/material/node/node-material";
import { _invalidateSceneUboCaches } from "../../../packages/babylon-lite/src/scene/scene-ubo-extras";
import { ensureSceneLightState } from "../../../packages/babylon-lite/src/render/scene-lights-ubo";
import type { GlowMaterialContext } from "../../../packages/babylon-lite/src/material/glow/glow-material";
import { createGlowDraw, drawGlowMaterial, updateGlowDraw } from "../../../packages/babylon-lite/src/material/glow/glow-material";
import { readGlowSurface } from "../../../packages/babylon-lite/src/material/glow/glow-source";

function fixture(samples = 1) {
    const pass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        draw: vi.fn(),
        drawIndexed: vi.fn(),
        drawIndexedIndirect: vi.fn(),
        executeBundles: vi.fn(),
        setViewport: vi.fn(),
        end: vi.fn(),
    };
    const bundle = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        drawIndexed: vi.fn(),
        drawIndexedIndirect: vi.fn(),
        finish: vi.fn(() => ({}) as GPURenderBundle),
    };
    const begin = vi.fn((_descriptor: GPURenderPassDescriptor) => Object.assign({} as GPURenderPassEncoder, pass));
    const textures: GPUTexture[] = [];
    const device = Object.assign({} as GPUDevice, {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => Object.assign({} as GPUBuffer, { size: descriptor.size, destroy: vi.fn() })),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const texture = Object.assign({} as GPUTexture, {
                format: descriptor.format,
                sampleCount: descriptor.sampleCount ?? 1,
                createView: vi.fn(() => Object.assign({} as GPUTextureView, { texture })),
                destroy: vi.fn(),
            });
            textures.push(texture);
            return texture;
        }),
        createBindGroupLayout: vi.fn((_descriptor: GPUBindGroupLayoutDescriptor) => ({}) as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((_descriptor: GPUPipelineLayoutDescriptor) => ({}) as GPUPipelineLayout),
        createShaderModule: vi.fn((_descriptor: GPUShaderModuleDescriptor) => ({}) as GPUShaderModule),
        createRenderPipeline: vi.fn((_descriptor: GPURenderPipelineDescriptor) => ({}) as GPURenderPipeline),
        createBindGroup: vi.fn((_descriptor: GPUBindGroupDescriptor) => ({}) as GPUBindGroup),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createRenderBundleEncoder: vi.fn((_descriptor: GPURenderBundleEncoderDescriptor) => Object.assign({} as GPURenderBundleEncoder, bundle)),
        queue: Object.assign({} as GPUQueue, { writeBuffer: vi.fn() }),
    });
    const size = { width: 64, height: 32 };
    const screen = createRenderTarget({ format: "bgra8unorm", samples: 1, size });
    const engine = Object.assign({} as EngineContext, {
        _device: device,
        _currentEncoder: { beginRenderPass: begin },
        canvas: size,
        scRT: screen,
        format: "bgra8unorm",
        msaaSamples: samples,
        _renderingContexts: [],
    });
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.camera = createArcRotateCamera(-Math.PI / 2, 1, 8, { x: 0, y: 0, z: 0 });
    const target = samples === 1 ? screen : createRenderTarget({ format: "bgra8unorm", dFormat: "depth24plus-stencil8", samples, size });
    buildRenderTarget(screen, engine);
    if (target !== screen) buildRenderTarget(target, engine);
    const mesh = (material: Material): Mesh => {
        const value = Object.assign({} as Mesh, {
            material,
            visible: true,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            _gpu: { positionBuffer: {}, normalBuffer: {}, uvBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint16" },
        });
        scene.meshes.push(value);
        return value;
    };
    const texture = (format: GPUTextureFormat = "rgba8unorm"): Texture2D => {
        const gpu = device.createTexture({ format, size: [1, 1], usage: 6 });
        return { texture: gpu, view: gpu.createView(), sampler: device.createSampler(), width: 1, height: 1 };
    };
    return { engine, scene, device, target, screen, size, textures, mesh, texture, pass, bundle, begin };
}

function drawUploads(device: GPUDevice): Float32Array[] {
    return (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[2])
        .filter((data): data is Float32Array => data instanceof Float32Array && data.length === 48);
}

/** A frame without any draw, measured rather than assumed: its returned work and its render passes. Each draw adds one. */
function emptyFrame(samples = 1): { work: number; passes: number } {
    const f = fixture(samples);
    const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
    task.record();
    const work = task.execute!();
    const passes = f.begin.mock.calls.length;
    task.dispose();
    return { work, passes };
}

/** Emissive-map and second blur-level sizes for an explicit `mainTextureRatio`. */
function mapSizes(size: { width: number; height: number }, ratio: number): [number, number][] {
    const map: [number, number] = [Math.floor(size.width * ratio), Math.floor(size.height * ratio)];
    return [map, [map[0] >> 1, map[1] >> 1]];
}

function materialContext(f: ReturnType<typeof fixture>): GlowMaterialContext {
    return {
        engine: f.engine,
        scene: f.scene,
        format: "rgba8unorm",
        variants: new Map(),
        programs: new Map(),
        targetTexture: null,
        frame: 1,
        skeleton: null,
        morph: null,
        instances: null,
        syncInstances: null,
        updateInstances: null,
        node: null,
        loading: null,
        disposed: false,
    };
}

describe("GlowPostProcessTask", () => {
    it("renders black opaque occluders and preserves borrowed MSAA color/depth ownership", async () => {
        const f = fixture(4);
        const emitter = createStandardMaterial();
        emitter.emissiveColor = [1, 0.2, 0];
        f.mesh(emitter);
        const occluder = f.mesh(createStandardMaterial());
        const sourceColor = f.target._colorTexture!;
        const sourceDepth = f.target._depthTexture!;
        const task = createGlowPostProcessTask(
            {
                targetTexture: f.target,
                resolveTexture: f.screen,
                customEmissiveColorSelector(mesh, _material, color) {
                    if (mesh === occluder) color.r = color.g = color.b = color.a = 0;
                },
            },
            f.engine,
            f.scene
        );
        await task._preload!();
        task.record();
        const empty = emptyFrame(4);
        // One more unit of work per drawn mesh than an empty frame, without extra render passes.
        expect(task.execute!()).toBe(empty.work + 2);
        expect(f.begin).toHaveBeenCalledTimes(empty.passes);
        expect(task.outputTexture).toBe(f.target);
        expect(task.resolveTexture).toBe(f.screen);
        expect(f.target._colorTexture).toBe(sourceColor);
        expect(f.target._depthTexture).toBe(sourceDepth);
        const emissive = f.device.createRenderPipeline.mock.calls.map(([descriptor]) => descriptor).filter((descriptor) => descriptor.label === "glow-emissive");
        expect(emissive).toHaveLength(1);
        expect(emissive[0]!.depthStencil).toMatchObject({ format: "depth32float", depthWriteEnabled: true });
        expect([...emissive[0]!.fragment!.targets][0]!.blend).toBeUndefined();
        const uniforms = f.device.queue.writeBuffer.mock.calls.map((call) => call[2]).filter((data) => data instanceof Float32Array && data.length === 48);
        expect(uniforms).toHaveLength(2);
        expect(Array.from(uniforms[1] as Float32Array).slice(16, 20)).toEqual([0, 0, 0, 0]);
        const merge = f.device.createRenderPipeline.mock.calls.map(([descriptor]) => descriptor).find((descriptor) => descriptor.label === "glow-merge")!;
        expect(merge.multisample?.count).toBe(4);
        expect([...merge.fragment!.targets][0]!.blend?.alpha).toEqual({ srcFactor: "zero", dstFactor: "one" });
        task.dispose();
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(sourceColor.destroy).not.toHaveBeenCalled();
        expect(sourceDepth.destroy).not.toHaveBeenCalled();
    });

    it("chains both blur levels and changes kernels without replacing sampled textures", () => {
        const f = fixture();
        const ratio = 0.5;
        const task = createGlowPostProcessTask({ targetTexture: f.target, mainTextureRatio: ratio }, f.engine, f.scene);
        task.record();
        const blurPipelines = () =>
            f.device.createRenderPipeline.mock.calls.map(([descriptor]) => descriptor.label ?? "").filter((label) => label.startsWith(`${task.name}-blur-`));
        const recorded = blurPipelines();
        const views = task.blurredTextures.map((target) => target._colorView);
        const allocations = f.device.createTexture.mock.calls.length;
        const pipelines = f.device.createRenderPipeline.mock.calls.length;
        task.blurKernelSize = 64;
        task.execute!();
        expect(f.device.createTexture).toHaveBeenCalledTimes(allocations);
        // Each blur pass rebuilds its own pipeline once for the new kernel; nothing else recompiles.
        expect(recorded.length).toBeGreaterThan(0);
        expect(blurPipelines().slice(recorded.length).sort()).toEqual([...recorded].sort());
        expect(f.device.createRenderPipeline).toHaveBeenCalledTimes(pipelines + recorded.length);
        expect(task.blurredTextures.map((target) => target._colorView)).toEqual(views);
        expect(task.blurredTextures.map((target) => [target._width, target._height])).toEqual(mapSizes(f.size, ratio));
        const groups = f.device.createBindGroup.mock.calls.map(([descriptor]) => descriptor);
        const thirdBlur = groups.find((descriptor) => descriptor.label === "glow-blur-2-bind-group")!;
        expect([...thirdBlur.entries].find((entry) => entry.binding === 1)?.resource).toBe(task.blurredTextures[0]._colorView);
        task.dispose();
    });

    it("uses inclusion/exclusion without turning a selected mesh's alpha into its blend classification", () => {
        const f = fixture();
        const first = f.mesh(createStandardMaterial());
        const second = f.mesh(createStandardMaterial());
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        const empty = emptyFrame();
        expect(task.execute!()).toBe(empty.work + 2);
        task.includedOnlyMeshes.add(first);
        expect(task.execute!()).toBe(empty.work + 1);
        task.excludedMeshes.add(first);
        expect(task.execute!()).toBe(empty.work);
        task.includedOnlyMeshes.clear();
        task.excludedMeshes.clear();
        task.excludeByDefault = true;
        expect(task.execute!()).toBe(0);
        task.includedOnlyMeshes.add(second);
        expect(task.execute!()).toBe(empty.work + 1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("keeps a PBR unlit white surface non-emissive and honors explicit black factors and null texture overrides", () => {
        const f = fixture();
        const white = f.mesh(createPbrMaterial({ _unlit: true }));
        const emissiveTexture = f.texture();
        const textured = f.mesh(createPbrMaterial({ emissiveTexture }));
        const black = f.mesh(createPbrMaterial({ emissiveTexture, _emissiveColor: [0, 0, 0] }));
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        task.execute!();
        const colors: number[][] = [];
        task.customEmissiveColorSelector = (_mesh, _material, color) => {
            colors.push([color.r, color.g, color.b, color.a]);
        };
        task.customEmissiveTextureSelector = () => null;
        task.execute!();
        expect(colors).toEqual([
            [0, 0, 0, 1],
            [1, 1, 1, 1],
            [0, 0, 0, 1],
        ]);
        expect(white.material).not.toBe(textured.material);
        expect(black.material).not.toBe(white.material);
        const finalGroup = f.device.createBindGroup.mock.calls.at(-1)![0];
        expect([...finalGroup.entries]).toHaveLength(1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("submits no GPU work or selector calls while disabled", () => {
        const f = fixture();
        f.mesh(createStandardMaterial());
        const selector = vi.fn();
        const task = createGlowPostProcessTask({ targetTexture: f.target, isEnabled: false, customEmissiveColorSelector: selector }, f.engine, f.scene);
        task.record();
        expect(task.execute!()).toBe(0);
        expect(f.begin).not.toHaveBeenCalled();
        expect(selector).not.toHaveBeenCalled();
        task.isEnabled = true;
        expect(task.execute!()).toBe(emptyFrame().work + 1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("rejects emissive attachment feedback even when the previous texture used the same shader variant", () => {
        const f = fixture();
        const material = createPbrMaterial({ emissiveTexture: f.texture() });
        f.mesh(material);
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        task.execute!();
        const feedback: Texture2D = {
            texture: task.emissiveTexture._colorTexture!,
            view: task.emissiveTexture._colorView!,
            sampler: f.device.createSampler(),
            width: task.emissiveTexture._width,
            height: task.emissiveTexture._height,
        };
        task.customEmissiveTextureSelector = () => feedback;
        const passes = f.begin.mock.calls.length;
        expect(() => task.execute!()).toThrow("cannot sample its own emissive");
        expect(f.begin).toHaveBeenCalledTimes(passes);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("resizes its intermediates without rebuilding the caller's final target", () => {
        const f = fixture();
        const ratio = 0.5;
        const task = createGlowPostProcessTask({ targetTexture: f.target, mainTextureRatio: ratio }, f.engine, f.scene);
        task.record();
        f.size.width = 128;
        f.size.height = 64;
        buildRenderTarget(f.target, f.engine);
        const color = f.target._colorTexture!;
        task.record();
        expect(f.target._colorTexture).toBe(color);
        expect(color.destroy).not.toHaveBeenCalled();
        const [map, small] = mapSizes(f.size, ratio);
        expect([task.emissiveTexture._width, task.emissiveTexture._height]).toEqual(map);
        expect(task.blurredTextures.map((value) => [value._width, value._height])).toEqual([map, small]);
        task.dispose();
        expect(color.destroy).not.toHaveBeenCalled();
    });

    it("can remove and re-add the same scene mesh without retaining a disposed draw", () => {
        const f = fixture();
        const mesh = f.mesh(createStandardMaterial());
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        const empty = emptyFrame();
        expect(task.execute!()).toBe(empty.work + 1);
        task._removeMesh!(mesh);
        f.scene.meshes.length = 0;
        expect(task.execute!()).toBe(empty.work);
        f.scene.meshes.push(mesh);
        expect(task.execute!()).toBe(empty.work + 1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("rejects unsupported formats and invalid kernels before allocating their pipelines", () => {
        const f = fixture();
        expect(() => createGlowPostProcessTask({ targetTexture: f.target, mainTextureType: 1 }, f.engine, f.scene)).toThrow("mainTextureType");
        expect(() => createGlowPostProcessTask({ targetTexture: f.target, blurKernelSize: NaN }, f.engine, f.scene)).toThrow("blurKernelSize");
        expect(() => createGlowPostProcessTask({ targetTexture: f.target, alphaBlendingMode: 42 }, f.engine, f.scene)).toThrow("alphaBlendingMode");
        expect(f.device.createRenderPipeline).not.toHaveBeenCalled();
    });

    it("uploads only changed draw state and replays the emissive bundle until the draw list changes", () => {
        const f = fixture();
        const material = createStandardMaterial();
        material.emissiveColor = [0.2, 0.4, 0.6];
        const first = f.mesh(material);
        f.mesh(createStandardMaterial());
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        task.execute!();
        task.execute!();
        expect(drawUploads(f.device)).toHaveLength(2);
        expect(f.device.createRenderBundleEncoder).toHaveBeenCalledOnce();
        expect(f.pass.executeBundles).toHaveBeenCalledTimes(2);
        material.emissiveColor = [1, 0, 0];
        markMaterialUboDirty(material);
        task.execute!();
        expect(drawUploads(f.device)).toHaveLength(3);
        expect(f.device.createRenderBundleEncoder).toHaveBeenCalledOnce();
        const empty = emptyFrame();
        Object.assign(first, { visible: false });
        expect(task.execute!()).toBe(empty.work + 1);
        Object.assign(first, { visible: true });
        expect(task.execute!()).toBe(empty.work + 2);
        expect(f.device.createRenderBundleEncoder).toHaveBeenCalledTimes(3);
        expect(drawUploads(f.device)).toHaveLength(3);
        expect(f.device.createBuffer.mock.calls.filter(([descriptor]) => descriptor.label === "glow-draw")).toHaveLength(2);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("skips blur and merge only while an empty black map cannot change the destination", () => {
        const f = fixture();
        const empty = emptyFrame();
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        expect(task.execute!()).toBe(empty.work);
        expect(task.execute!()).toBe(0);
        expect(f.begin).toHaveBeenCalledTimes(empty.passes);
        task.neutralColor = { r: 0, g: 0, b: 0, a: 0.5 };
        expect(task.execute!()).toBe(empty.work);
        expect(task.execute!()).toBe(0);
        task.neutralColor = { r: 0.1, g: 0, b: 0, a: 0.5 };
        expect(task.execute!()).toBe(empty.work);
        expect(task.execute!()).toBe(empty.work);
        const combine = createGlowPostProcessTask({ targetTexture: f.target, alphaBlendingMode: 2 }, f.engine, f.scene);
        combine.record();
        expect(combine.execute!()).toBe(empty.work);
        expect(combine.execute!()).toBe(empty.work);
        task.dispose();
        combine.dispose();
    });

    it("projects a fixed-size map with the destination aspect", () => {
        const f = fixture();
        f.mesh(createStandardMaterial());
        const task = createGlowPostProcessTask({ targetTexture: f.target, mainTextureFixedSize: 16 }, f.engine, f.scene);
        task.record();
        task.execute!();
        const expected = new Float32Array(16);
        packMat4IntoF32(expected, getViewProjectionMatrix(f.scene.camera!, 2), 0);
        const uploads = f.device.queue.writeBuffer.mock.calls.map((call) => call[2]).filter((data) => data instanceof Float32Array && data.length === SCENE_UBO_BYTES / 4);
        expect(uploads.map((data) => Array.from((data as Float32Array).subarray(0, 16)))).toEqual([Array.from(expected)]);
        expect([task.emissiveTexture._width, task.emissiveTexture._height]).toEqual([16, 16]);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("samples Standard diffuse alpha only for an alpha test that has a diffuse texture", () => {
        const f = fixture();
        const translucent = createStandardMaterial();
        translucent.alpha = 0.5;
        translucent.diffuseTexture = f.texture();
        const untextured = createStandardMaterial();
        untextured.alphaCutOff = 0.5;
        const cutout = createStandardMaterial();
        cutout.alphaCutOff = 0.5;
        cutout.diffuseTexture = f.texture();
        f.mesh(translucent);
        f.mesh(untextured);
        f.mesh(cutout);
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        expect(task.execute!()).toBe(emptyFrame().work + 3);
        const groups = f.device.createBindGroup.mock.calls.map(([descriptor]) => descriptor).filter((descriptor) => descriptor.label === "glow-draw");
        expect(groups.map((descriptor) => [...descriptor.entries].length)).toEqual([1, 1, 3]);
        const fragments = f.device.createShaderModule.mock.calls.map(([descriptor]) => descriptor).filter((descriptor) => descriptor.label === "glow-fragment");
        expect(fragments.map((descriptor) => descriptor.code.includes("discard"))).toEqual([false, false, true]);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("skips a mesh whose deformation helpers were not prepared instead of failing the frame", () => {
        const f = fixture();
        Object.assign(f.mesh(createStandardMaterial()), { morphTargets: {} });
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        expect(task.execute!()).toBe(emptyFrame().work);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("renders a NodeMaterial glow output through its own shader, other node and shader surfaces in the neutral color", async () => {
        const f = fixture();
        const glowing = await parseNodeMaterialFromSnippet(f.engine, "", { json: nodeGraph(true) });
        const plain = await parseNodeMaterialFromSnippet(f.engine, "", { json: nodeGraph(false) });
        const shader = {
            _buildGroup: { _materialFamily: "shader" },
            blendMode: "additive",
            needAlphaBlending: true,
            _topology: "line-list",
            backFaceCulling: false,
        } as unknown as Material;
        f.mesh(glowing);
        f.mesh(glowing);
        f.mesh(plain);
        f.mesh(shader);
        const selected: Material[] = [];
        const task = createGlowPostProcessTask({ targetTexture: f.target, customEmissiveColorSelector: (_mesh, material) => void selected.push(material) }, f.engine, f.scene);
        task.neutralColor = { r: 0.25, g: 0.5, b: 0.75, a: 1 };
        await task._preload!();
        task.record();
        task.execute!();

        const code = f.device.createShaderModule.mock.calls.map(([descriptor]) => descriptor.code);
        expect(code.some((source) => /_NME_FRAG_OUTPUT_ = vec4<f32>\([^;]*glowColor[^;]*, 1\.0\);/.test(source))).toBe(true);
        // Selectors and the neutral color apply to generic surfaces only; both glowing meshes share one program.
        expect(selected).toEqual([plain, shader]);
        expect(drawUploads(f.device).map((data) => Array.from(data.slice(16, 20)))).toEqual([
            [0.25, 0.5, 0.75, 1],
            [0.25, 0.5, 0.75, 1],
        ]);
        const buffers = f.device.createBuffer.mock.calls.map(([descriptor]) => descriptor.label);
        expect(buffers.filter((label) => label === "glow-node-ubo")).toHaveLength(1);
        expect(buffers.filter((label) => label === "glow-node-mesh")).toHaveLength(2);
        const generic = f.device.createRenderPipeline.mock.calls.map(([descriptor]) => descriptor).filter((descriptor) => descriptor.label === "glow-emissive");
        expect(
            generic.map((descriptor) => [descriptor.primitive?.topology ?? "triangle-list", descriptor.primitive?.cullMode, descriptor.depthStencil?.depthWriteEnabled])
        ).toEqual([
            ["triangle-list", "back", true],
            ["line-list", "none", false],
        ]);
        expect([...generic[1]!.fragment!.targets][0]!.blend).toEqual({ color: { srcFactor: "src-alpha", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } });

        // Node uniforms are synchronized once per frame, and uploaded only when a value changed.
        const nodeUbo = f.device.createBuffer.mock.results.map((result) => result.value as GPUBuffer).find((_, i) => buffers[i] === "glow-node-ubo")!;
        const nodeUploads = () => f.device.queue.writeBuffer.mock.calls.filter(([buffer]) => buffer === nodeUbo).length;
        expect(nodeUploads()).toBe(1);
        task.execute!();
        expect(nodeUploads()).toBe(1);
        glowing.inputs["glowColor"]!.value = [1, 0, 0];
        task.execute!();
        expect(nodeUploads()).toBe(2);

        // Glow-mode bindings and bundle stay recorded in steady state, and follow scene renderable rebuilds.
        const nodeGroups = () => f.device.createBindGroup.mock.calls.filter(([descriptor]) => descriptor.label === "glow-node").length;
        const groups = nodeGroups();
        const bundles = f.device.createRenderBundleEncoder.mock.calls.length;
        task.execute!();
        expect([nodeGroups(), f.device.createRenderBundleEncoder.mock.calls.length]).toEqual([groups, bundles]);
        f.scene._renderableVersion++;
        task.execute!();
        expect([nodeGroups(), f.device.createRenderBundleEncoder.mock.calls.length]).toEqual([groups + 2, bundles + 1]);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("rewrites its scene uniforms when a scene-uniform writer invalidates the scene caches", () => {
        const f = fixture();
        f.mesh(createStandardMaterial());
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        f.scene._frameGraph._tasks.push(task);
        task.record();
        const sceneUploads = () => f.device.queue.writeBuffer.mock.calls.filter(([, , data]) => data instanceof Float32Array && data.length === SCENE_UBO_BYTES / 4).length;
        task.execute!();
        const uploads = sceneUploads();
        task.execute!();
        expect(sceneUploads()).toBe(uploads);
        // Environment rotation/blur, clip planes and the procedural sky change scene uniforms outside the change key.
        _invalidateSceneUboCaches(f.scene);
        task.execute!();
        expect(sceneUploads()).toBe(uploads + 1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("restores the material's emissive texture once the texture selector is removed", () => {
        const f = fixture();
        f.mesh(createPbrMaterial({ emissiveTexture: f.texture() }));
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        task.record();
        const drawEntries = () => [...f.device.createBindGroup.mock.calls.filter(([descriptor]) => descriptor.label === "glow-draw").at(-1)![0].entries].length;
        task.execute!();
        const textured = drawEntries();
        task.customEmissiveTextureSelector = () => null;
        task.execute!();
        expect(drawEntries()).toBeLessThan(textured);
        task.customEmissiveTextureSelector = undefined;
        task.execute!();
        expect(drawEntries()).toBe(textured);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("draws a single instance again once a draw's thin-instance input is gone", async () => {
        const f = fixture();
        const context = materialContext(f);
        const node = await import("../../../packages/babylon-lite/src/material/glow/glow-node");
        context.node = node;
        const glowing = await parseNodeMaterialFromSnippet(f.engine, "", { json: nodeGraph(true) });
        await node.prepareGlowNode(context, glowing);
        const encoder = Object.assign({} as GPURenderBundleEncoder, f.bundle);
        for (const material of [createStandardMaterial(), glowing]) {
            const mesh = f.mesh(material);
            const draw = createGlowDraw(context, mesh);
            readGlowSurface(material, draw.surface);
            // As left by earlier frames whose thin-instance count used indirect arguments.
            draw.indirect = draw.instances = {} as GPUBuffer;
            expect(updateGlowDraw(context, draw, true, draw.surface.color)).toBe(1);
            expect([draw.indirect, draw.instances]).toEqual([null, null]);
            drawGlowMaterial(context, draw, encoder);
        }
        expect(f.bundle.drawIndexedIndirect).not.toHaveBeenCalled();
        expect(f.bundle.drawIndexed.mock.calls.map((call) => call[1] ?? 1)).toEqual([1, 1]);
        disposeGpuResourceRetirements(f.engine);
    });

    it("does not publish a NodeMaterial glow program prepared after disposal", async () => {
        const f = fixture();
        f.mesh(await parseNodeMaterialFromSnippet(f.engine, "", { json: nodeGraph(true) }));
        const task = createGlowPostProcessTask({ targetTexture: f.target }, f.engine, f.scene);
        const preparing = task._preload!();
        task.dispose();
        const buffers = f.device.createBuffer.mock.calls.length;
        await preparing;
        expect(f.device.createBuffer).toHaveBeenCalledTimes(buffers);
    });

    it("binds lights relative to a camera override under floating origin for NodeMaterial glow programs", async () => {
        const f = fixture();
        const origins: unknown[] = [];
        Object.assign(f.engine, {
            useFloatingOrigin: true,
            _makePackMeshWorld: () => (data: Float32Array, world: Float32Array, offset: number) => packMat4IntoF32(data, world, offset),
            _applyLightFoOffset: (_data: Float32Array, scene: SceneContext) => void origins.push(scene.camera),
        });
        f.mesh(await parseNodeMaterialFromSnippet(f.engine, "", { json: nodeGraph(true) }));
        const override = createArcRotateCamera(0, 1, 8, { x: 0, y: 0, z: 0 });
        const task = createGlowPostProcessTask({ targetTexture: f.target, camera: override }, f.engine, f.scene);
        await task._preload!();
        task.record();
        const shared = ensureSceneLightState(f.engine, f.scene)._buffer;
        const boundLights = () => {
            const groups = f.device.createBindGroup.mock.calls.map(([descriptor]) => [...descriptor.entries]);
            const scene = groups.filter((entries) => entries.length === 2 && (entries[0]!.resource as GPUBufferBinding).buffer.size === SCENE_UBO_BYTES).at(-1)!;
            return (scene[1]!.resource as GPUBufferBinding).buffer;
        };
        task.execute!();
        expect(boundLights()).not.toBe(shared);
        expect(origins.at(-1)).toBe(override);
        // Without an override the scene camera's shared lights already have the right origin.
        task.camera = null;
        task.execute!();
        expect(boundLights()).toBe(shared);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });
});

/** Minimal NME graph: a world/view-projection vertex graph and a colour output, optionally with a glow output. */
function nodeGraph(glow: boolean): Record<string, unknown> {
    const input = (id: number, name: string, extra: Record<string, unknown>) => ({
        customType: "BABYLON.InputBlock",
        id,
        name,
        inputs: [],
        outputs: [{ name: "output" }],
        ...extra,
    });
    const link = (name: string, targetBlockId: number) => ({ name, targetBlockId, targetConnectionName: "output" });
    const transform = (id: number, vector: number, matrix: number) => ({
        customType: "BABYLON.TransformBlock",
        id,
        name: `transform${id}`,
        inputs: [link("vector", vector), link("transform", matrix)],
        outputs: [{ name: "output" }, { name: "xyz" }],
        complementZ: 0,
        complementW: 1,
    });
    return {
        backFaceCulling: true,
        alphaMode: 2,
        blocks: [
            input(1, "position", { mode: 1, type: 8 }),
            input(2, "world", { mode: 0, type: 128, systemValue: 1 }),
            transform(3, 1, 2),
            input(4, "viewProjection", { mode: 0, type: 128, systemValue: 4 }),
            transform(5, 3, 4),
            { customType: "BABYLON.VertexOutputBlock", id: 6, name: "vertex", inputs: [link("vector", 5)], outputs: [] },
            input(7, "baseColor", { mode: 0, type: 32, valueType: "BABYLON.Color3", value: [1, 0.5, 0.25] }),
            input(8, "glowColor", { mode: 0, type: 32, valueType: "BABYLON.Color3", value: [0, 1, 0] }),
            { customType: "BABYLON.FragmentOutputBlock", id: 9, name: "fragment", inputs: [link("rgb", 7), ...(glow ? [link("glow", 8)] : [])], outputs: [] },
        ],
        outputNodes: [6, 9],
    };
}
