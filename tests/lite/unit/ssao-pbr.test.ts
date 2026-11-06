import { describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createIblFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment.js";
import * as PbrBinding from "../../../packages/babylon-lite/src/material/pbr/pbr-binding-decorator.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_HAS_REFRACTION, PBR2_NO_COLOR_OUTPUT, PBR2_ESM_SHADOW_OUTPUT } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits.js";
import { enableDynamicPbrBindings } from "../../../packages/babylon-lite/src/material/plugin/dynamic-pbr-bindings.js";
import type { MaterialPlugin, PluginTextureBinding } from "../../../packages/babylon-lite/src/material/plugin/material-plugin.js";
import { isPbrIblColorPass, selectPbrPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-passes.js";
import { registerPbrPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-bridge.js";
import type { PbrExt, _PbrFragCtx } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import { enablePbrSsao } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-pbr.js";
import type { SsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";
import type { DrawBinding } from "../../../packages/babylon-lite/src/render/renderable.js";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { getTextureReferenceStore } from "../../../packages/babylon-lite/src/resource/texture-reference-store.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { _createAutomaticRenderTask, _removeMeshFromRenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task-base.js";
import { createRenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task.js";
import { drawBindingLifecycle } from "../../../packages/babylon-lite/src/render/draw-binding-lifecycle.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";

const install = vi.spyOn(PbrBinding, "installPbrBindingDecorator");
enableDynamicPbrBindings();
const decorate = install.mock.calls[0]![0];

function pluginBridge(): PbrExt {
    let extension: PbrExt | undefined;
    registerPbrPlugins((value) => (extension = value));
    return extension!;
}

function texture(): Texture2D {
    const allocation = { createView: () => ({}), destroy: vi.fn() } as unknown as GPUTexture;
    return { texture: allocation, view: allocation.createView(), sampler: {} as GPUSampler, width: 1, height: 1 };
}

function fixture() {
    const device = {
        createTexture: vi.fn(() => texture().texture),
        createSampler: () => ({}),
        queue: { writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [], _renderingContexts: [], format: "rgba8unorm" } as unknown as EngineContext;
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    scene.camera = camera;
    const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 128, height: 96 } });
    const task = createSsaoTask({ temporal: false, depthTexture: depth, camera }, engine, scene);
    const material = createPbrMaterial();
    return { device, engine, scene, camera, task, material };
}

function sampled(plugin: MaterialPlugin): Texture2D {
    const bindings: PluginTextureBinding[] = [];
    plugin.bindTextures!(bindings);
    return bindings[0]!.texture;
}

function renderFixture() {
    const f = fixture();
    const pass = {
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: vi.fn(),
        setScissorRect: vi.fn(),
        executeBundles: vi.fn(),
        end: vi.fn(),
    };
    Object.assign(f.device, {
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(Number(descriptor.size)), unmap: vi.fn() }),
        createBindGroupLayout: () => ({}),
        createBindGroup: () => ({}),
        createRenderBundleEncoder: () => ({ ...pass, finish: () => ({}) }),
    });
    Object.assign(f.device.queue, { writeBuffer: vi.fn() });
    Object.assign(f.engine, {
        canvas: { width: 128, height: 96 },
        _currentEncoder: { beginRenderPass: () => pass },
    });
    return f;
}

function publishOutput(f: ReturnType<typeof fixture>, width = 128, height = 96) {
    const output = texture();
    const gpu = { visibility: output.texture, width, height } as SsaoGpu;
    f.task.outputTexture._colorView = output.view;
    f.task._onOutputChanged!(gpu, f.task.outputTexture);
    return { output, gpu };
}

function addDynamicRenderable(f: ReturnType<typeof fixture>) {
    const ao = f.material.plugins![0]!;
    const pipeline = {} as GPURenderPipeline;
    const makeGroup = vi.fn(() => ({ texture: sampled(ao).texture }) as unknown as GPUBindGroup);
    const disposers: (() => void)[] = [];
    const renderable: Renderable = {
        order: 0,
        isTransparent: false,
        mesh: {} as Mesh,
        bind() {
            const binding: DrawBinding = { renderable, pipeline, draw: () => 1 };
            return decorate(binding, f.engine, [ao], "ibl", 0, 0, makeGroup, () => 1, disposers, f.scene);
        },
    };
    f.scene._renderables.push(renderable);
    return { renderable, makeGroup, disposers };
}

describe("IBL calculation selection", () => {
    it("preserves three-argument calls and an undefined visibility expression", () => {
        const baseline = createIblFragment(false);
        expect(createIblFragment(false, undefined, undefined, undefined)).toEqual(baseline);
        expect(baseline._fragmentSlots!.AI).toContain("environmentIrradiance * surfaceAlbedo * occlusion;");
        expect(baseline._fragmentSlots!.AI).toContain("let eho = 1.0;");
    });

    it("changes only diffuse irradiance when selecting a visibility expression", () => {
        const baseline = createIblFragment(true)._fragmentSlots!.AI!;
        const selected = createIblFragment(true, undefined, undefined, wgsl`min(occlusion,ssaoDiffuseVisibility)`)._fragmentSlots!.AI;
        expect(selected).toBe(
            baseline.replace("environmentIrradiance * surfaceAlbedo * occlusion;", "environmentIrradiance * surfaceAlbedo * min(occlusion,ssaoDiffuseVisibility);")
        );
        expect(selected).toContain("let eho = environmentHorizonOcclusion(-V, N, N_geom);");
    });

    it("preserves anisotropic reflection when selecting diffuse visibility", () => {
        const reflection = wgsl`let R_raw = anisotropicReflection;`;
        const fragment = createIblFragment(false, reflection, undefined, wgsl`min(occlusion,ssaoDiffuseVisibility)`);
        expect(fragment._fragmentSlots!.AI).toContain(reflection);
        expect(fragment._fragmentSlots!.AI).not.toContain("let R_raw = reflect(-V, N);");
    });

    it("keeps pre-baked skybox calculations unchanged", () => {
        const skybox = wgsl`let finalIrradiance = vec3f(1);`;
        const baseline = createIblFragment(true, undefined, skybox);
        expect(createIblFragment(true, undefined, skybox, wgsl`min(occlusion,ssaoDiffuseVisibility)`)).toEqual(baseline);
        expect(baseline._fragmentSlots!.AI).toBe(skybox);
    });
});

describe("PBR SSAO scope and ownership", () => {
    it("creates identical white nearest fallbacks without sharing task and engine ownership", async () => {
        const f = fixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const plugin = f.material.plugins![0]!;
        const neutral = sampled(plugin);
        const plain = createSceneContext(f.engine, { defaultRenderTask: false });
        plugin._selectBindingScope!(plain);
        const fallback = sampled(plugin);
        expect(fallback).not.toBe(neutral);
        expect(fallback.sampler).toBe(neutral.sampler);
        expect(vi.mocked(f.device.queue.writeTexture).mock.calls.map(([, data]) => data)).toEqual([new Uint8Array([255, 255, 255, 255]), new Uint8Array([255, 255, 255, 255])]);
        expect(getTextureReferenceStore().get(neutral.texture)).toBe(2);
        expect(getTextureReferenceStore().get(fallback.texture)).toBe(1);
        for (const dispose of f.scene._disposables) dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(neutral.texture.destroy).toHaveBeenCalledOnce();
        expect(fallback.texture.destroy).not.toHaveBeenCalled();
        f.engine._disposeManagedResources?.();
        expect(fallback.texture.destroy).toHaveBeenCalledOnce();
    });

    it("keeps a shared source material's sampling and disposal isolated by consuming scene", async () => {
        const first = fixture(),
            second = fixture(),
            plain = fixture();
        first.material._renderFeatures = { features: 0, features2: 0 };
        await enablePbrSsao(first.scene, first.task, [first.material]);
        expect(first.material._renderFeatures).toBeUndefined();
        const plugin = first.material.plugins![0]!;
        await enablePbrSsao(second.scene, second.task, [first.material]);
        expect(first.material.plugins).toEqual([plugin]);
        const outputA = texture(),
            outputB = texture();
        const gpuA = { visibility: outputA.texture, width: 128, height: 96 } as SsaoGpu,
            gpuB = { visibility: outputB.texture, width: 128, height: 96 } as SsaoGpu;
        first.task.outputTexture._colorView = outputA.view;
        second.task.outputTexture._colorView = outputB.view;
        first.task._onOutputChanged!(gpuA, first.task.outputTexture);
        second.task._onOutputChanged!(gpuB, second.task.outputTexture);
        plugin._selectBindingScope!(first.scene);
        expect(sampled(plugin).texture).toBe(outputA.texture);
        expect(() => plugin._prepareDraw!({ _camera: first.camera, targetWidth: 128, targetHeight: 96 })).not.toThrow();
        plugin._selectBindingScope!(second.scene);
        expect(sampled(plugin).texture).toBe(outputB.texture);
        expect(() => plugin._prepareDraw!({ _camera: second.camera, targetWidth: 128, targetHeight: 96 })).not.toThrow();
        plugin._selectBindingScope!(plain.scene);
        expect(sampled(plugin).texture).not.toBe(outputA.texture);
        expect(sampled(plugin).texture).not.toBe(outputB.texture);
        expect(() => plugin._prepareDraw!({ _camera: plain.camera, targetWidth: 128, targetHeight: 96 })).not.toThrow();
        for (const dispose of first.scene._disposables) dispose();
        expect(first.material.plugins).toEqual([plugin]);
        plugin._selectBindingScope!(second.scene);
        expect(sampled(plugin).texture).toBe(outputB.texture);
        for (const dispose of second.scene._disposables) dispose();
        expect(first.material.plugins).toEqual([]);
        expect(first.material._renderFeatures).toBeUndefined();
        await enablePbrSsao(plain.scene, plain.task, [first.material]);
        expect(first.material.plugins).toHaveLength(1);
        expect(first.material.plugins![0]).not.toBe(plugin);
        first.material.plugins![0]!._selectBindingScope!(plain.scene);
        expect(sampled(first.material.plugins![0]!).width).toBe(1);
        for (const dispose of plain.scene._disposables) dispose();
        expect(first.material.plugins).toEqual([]);
        gpuA.releaseVisibility!();
        gpuB.releaseVisibility!();
        plain.engine._disposeManagedResources?.();
        for (const engine of [first.engine, second.engine, plain.engine]) disposeGpuResourceRetirements(engine);
    });
    it("preserves existing plugins, deduplicates materials, and is idempotent", async () => {
        const f = fixture();
        const existing: MaterialPlugin = { name: "existing" };
        f.material.plugins = [existing];
        await enablePbrSsao(f.scene, f.task, [f.material, f.material]);
        const ao = f.material.plugins[1]!;
        await enablePbrSsao(f.scene, f.task, [f.material]);
        expect(f.material.plugins).toEqual([existing, ao]);
        expect(sampled(ao).width).toBe(1);
        expect(ao.getCustomCode!("fragment")!.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain("scene.viewProjection");
        expect(ao.getSamplers!()[0]!.samplerType).toBe("sampler_non_filtering");
    });

    it.each([
        ["opaque", 0, 0, true, true],
        ["no IBL", 0, 0, false, false],
        ["transparent", PBR_HAS_ALPHA_BLEND, 0, true, false],
        ["depth", 0, PBR2_NO_COLOR_OUTPUT, true, false],
        ["ESM", 0, PBR2_ESM_SHADOW_OUTPUT, true, false],
        ["geometry", 0, 1 << 21, true, false],
        ["unlit", 0, 1 << 8, true, false],
        ["refraction", 0, PBR2_HAS_REFRACTION, true, false],
    ] as const)("keeps shader declarations and binding selection consistent for %s", async (_name, features, features2, ibl, expected) => {
        const f = fixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const ao = f.material.plugins![0]!;
        const eligible = isPbrIblColorPass(features, features2, ibl);
        expect(eligible).toBe(expected);
        const bridge = pluginBridge();
        bridge.detect!(f.material);
        const fragment = bridge.frag!({ _pi: f.material._pi, _features: features, _features2: features2, _hasIbl: ibl } as _PbrFragCtx);
        expect(fragment?._bindings?.length ?? 0).toBe(expected ? 2 : 0);
        expect(selectPbrPlugins([ao], eligible).length).toBe(expected ? 1 : 0);
        expect(fragment?._fragmentSlots?.SV?.includes("ssaoDiffuseVisibility") ?? false).toBe(expected);
    });

    it("includes IBL-only scope in immutable shader signatures", () => {
        const plugin: MaterialPlugin = { name: "same-shader", getCustomCode: () => ({ CUSTOM_FRAGMENT_MAIN_BEGIN: "let foo=1;" }) };
        const bridge = pluginBridge();
        const ordinary = createPbrMaterial(),
            scoped = createPbrMaterial();
        ordinary.plugins = [plugin];
        scoped.plugins = [{ ...plugin, _pbrIblOnly: true }];
        bridge.detect!(ordinary);
        bridge.detect!(scoped);
        expect(ordinary._pi).not.toBe(scoped._pi);
        const identity = scoped._pi;
        bridge.detect!(scoped);
        expect(scoped._pi).toBe(identity);
    });

    it("rejects mismatched cameras and attachment conflicts without changing materials", async () => {
        const f = fixture();
        f.scene.camera = createFreeCamera({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 });
        await expect(enablePbrSsao(f.scene, f.task, [f.material])).rejects.toThrow("active camera");
        f.scene.camera = f.camera;
        const conflict = createPbrMaterial();
        conflict.plugins = [{ name: "ssao-diffuse-ibl" }];
        await expect(enablePbrSsao(f.scene, f.task, [f.material, conflict])).rejects.toThrow("already attached");
        expect(f.material.plugins).toBeUndefined();
        f.task.dispose();
        await expect(enablePbrSsao(f.scene, f.task, [f.material])).rejects.toThrow("disposed");
    });

    it("publishes output generations, neutralizes other cameras, and returns to neutral on disposal", async () => {
        const f = fixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const ao = f.material.plugins![0]!;
        const neutral = sampled(ao);
        const output = texture();
        const gpu = { visibility: output.texture, width: 128, height: 96 } as SsaoGpu;
        f.task.outputTexture._colorView = output.view;
        f.task._onOutputChanged!(gpu, f.task.outputTexture);
        expect(sampled(ao).texture).toBe(output.texture);
        expect(ao._bindingVersion!()).toBe(2);
        expect(() => ao._prepareDraw!({ _camera: f.camera, targetWidth: 256, targetHeight: 192 })).not.toThrow();
        expect(sampled(ao).texture).toBe(output.texture);
        for (const camera of [null, createFreeCamera({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 })]) {
            expect(() => ao._prepareDraw!({ _camera: camera, targetWidth: 128, targetHeight: 128 })).not.toThrow();
            expect(sampled(ao)).toBe(neutral);
            expect(ao._bindingVersion!()).toBe(3);
        }
        expect(() => ao._prepareDraw!({ _camera: f.camera, targetWidth: 128, targetHeight: 128 })).toThrow("aspect ratio");
        ao._prepareDraw!({ _camera: f.camera, targetWidth: 128, targetHeight: 96 });
        expect(sampled(ao).texture).toBe(output.texture);
        f.task.dispose();
        expect(sampled(ao)).toBe(neutral);
        gpu.releaseVisibility!();
        for (const dispose of f.scene._disposables) dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(output.texture.destroy).toHaveBeenCalledOnce();
        expect(neutral.texture.destroy).toHaveBeenCalledOnce();
        expect(f.material.plugins).toEqual([]);
    });

    it("recreates the neutral fallback before a replacement-device material binds", async () => {
        const f = fixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const ao = f.material.plugins![0]!;
        const old = sampled(ao);
        const next = fixture();
        f.engine._device = next.device;
        const replacement = sampled(ao);
        expect(replacement.texture).not.toBe(old.texture);
        expect(ao._bindingVersion!()).toBe(2);
        for (const dispose of f.scene._disposables) dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(old.texture.destroy).toHaveBeenCalledOnce();
        expect(replacement.texture.destroy).toHaveBeenCalledOnce();
    });
});

describe("dynamic PBR binding generations", () => {
    it("releases temporary automatic-pass leases before repeated AO resize cycles while the mesh lives", async () => {
        const f = renderFixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const mesh = addDynamicRenderable(f);
        let current = publishOutput(f);
        for (let cycle = 0; cycle < 3; cycle++) {
            const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 128, height: 96 } });
            const pass = _createAutomaticRenderTask({ name: "temporary", rt }, f.engine, f.scene);
            pass.record();
            pass.execute!();
            const binding = pass._opaqueBindings[0]!;
            pass.dispose();
            pass.dispose();
            expect(() => binding.update!(pass._updateContext)).toThrow("retired");
            const previous = current;
            current = publishOutput(f);
            previous.gpu.releaseVisibility!();
            expect(previous.output.texture.destroy).not.toHaveBeenCalled();
            disposeGpuResourceRetirements(f.engine);
            expect(previous.output.texture.destroy).toHaveBeenCalledOnce();
            expect(mesh.disposers).toHaveLength(1);
        }
        expect(f.scene._renderables).toContain(mesh.renderable);
        f.task.dispose();
        current.gpu.releaseVisibility!();
        mesh.disposers.forEach((dispose) => dispose());
        f.scene._disposables.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(f.engine);
        expect(current.output.texture.destroy).toHaveBeenCalledOnce();
    });

    it("retires replaced explicit binding generations and removed bindings without retiring the mesh", async () => {
        const f = renderFixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const mesh = addDynamicRenderable(f);
        const output = publishOutput(f);
        const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 128, height: 96 } });
        const pass = createRenderTask({ name: "explicit", rt }, f.engine, f.scene);
        pass.record();
        pass.execute!();
        const old = pass._opaqueBindings[0]!;
        pass.record();
        expect(() => old.draw({} as GPURenderPassEncoder, f.engine)).toThrow("updated before drawing");
        pass.execute!();
        expect(mesh.makeGroup).toHaveBeenCalledTimes(2);
        const active = pass._opaqueBindings[0]!;
        _removeMeshFromRenderTask(pass, mesh.renderable.mesh!);
        expect(() => active.update!(pass._updateContext)).toThrow("retired");
        const next = publishOutput(f);
        output.gpu.releaseVisibility!();
        disposeGpuResourceRetirements(f.engine);
        expect(output.output.texture.destroy).toHaveBeenCalledOnce();
        expect(mesh.disposers).toHaveLength(1);
        pass.dispose();
        f.task.dispose();
        next.gpu.releaseVisibility!();
        mesh.disposers.forEach((dispose) => dispose());
        f.scene._disposables.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(f.engine);
    });

    it("preserves the live generation after a candidate bind fails", async () => {
        const f = renderFixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const mesh = addDynamicRenderable(f);
        const output = publishOutput(f);
        const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 128, height: 96 } });
        const pass = _createAutomaticRenderTask({ name: "rollback", rt }, f.engine, f.scene);
        pass.record();
        pass.execute!();
        const active = pass._opaqueBindings[0]!;
        const refs = getTextureReferenceStore().get(output.output.texture);
        f.scene._renderables.push({
            order: 0,
            isTransparent: false,
            bind: () => {
                throw new Error("candidate failed");
            },
        });
        expect(() => pass.record()).toThrow("candidate failed");
        expect(pass._opaqueBindings[0]).toBe(active);
        disposeGpuResourceRetirements(f.engine);
        expect(getTextureReferenceStore().get(output.output.texture)).toBe(refs);
        expect(() => active.draw({} as GPURenderPassEncoder, f.engine)).not.toThrow();
        pass.dispose();
        f.task.dispose();
        output.gpu.releaseVisibility!();
        mesh.disposers.forEach((dispose) => dispose());
        f.scene._disposables.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(f.engine);
    });

    it.each([false, true])("uses canvas projection aspect for square cs passes, including viewports (%s)", async (viewport) => {
        const f = renderFixture();
        if (viewport) {
            f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        }
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const mesh = addDynamicRenderable(f);
        const output = publishOutput(f);
        const rt = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 64, height: 64 } });
        const config = { name: "canvas aspect", rt, cs: true };
        const pass = _createAutomaticRenderTask(config, f.engine, f.scene);
        pass.record();
        expect(() => pass.execute!()).not.toThrow();
        expect(pass._updateContext._projectionAspect).toBe((128 / 96) * (viewport ? 0.5 : 1));
        expect(() => pass.execute!()).not.toThrow();
        expect(mesh.makeGroup).toHaveBeenCalledOnce();
        config.cs = false;
        expect(() => pass.execute!()).toThrow("aspect ratio");
        config.cs = true;
        f.engine.canvas.width = 96;
        expect(() => pass.execute!()).toThrow("aspect ratio");
        const resized = publishOutput(f, 96, 96);
        expect(() => pass.execute!()).not.toThrow();
        pass.dispose();
        f.task.dispose();
        output.gpu.releaseVisibility!();
        resized.gpu.releaseVisibility!();
        mesh.disposers.forEach((dispose) => dispose());
        f.scene._disposables.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(f.engine);
    });

    it("retains a shared context state until its last binding retires and preserves retained bindings", () => {
        const f = fixture();
        const source = texture();
        const plugin: MaterialPlugin = { name: "shared", _bindingVersion: () => 0, getActiveTextures: (out) => out.push(source) };
        const binding: DrawBinding = {
            renderable: { order: 0, isTransparent: false, bind: () => binding },
            pipeline: {} as GPURenderPipeline,
            draw: () => 1,
        };
        const disposers: (() => void)[] = [];
        const a = decorate(
            binding,
            f.engine,
            [plugin],
            "ibl",
            0,
            0,
            () => ({}) as GPUBindGroup,
            () => 1,
            disposers
        );
        const b = decorate(
            binding,
            f.engine,
            [plugin],
            "ibl",
            0,
            0,
            () => ({}) as GPUBindGroup,
            () => 1,
            disposers
        );
        const context = { targetWidth: 128, targetHeight: 96 };
        a.update!(context);
        b.update!(context);
        drawBindingLifecycle!._retire([[a]]);
        drawBindingLifecycle!._retire([[b]], [[b]]);
        disposeGpuResourceRetirements(f.engine);
        expect(source.texture.destroy).not.toHaveBeenCalled();
        expect(() => b.draw({} as GPURenderPassEncoder, f.engine)).not.toThrow();
        drawBindingLifecycle!._retire([[b]]);
        expect(source.texture.destroy).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(f.engine);
        expect(source.texture.destroy).toHaveBeenCalledOnce();
        expect(disposers).toHaveLength(1);
        disposers.forEach((dispose) => dispose());
    });

    it("keeps AO and neutral generations isolated for passes sharing one renderable and pipeline", async () => {
        const f = fixture();
        await enablePbrSsao(f.scene, f.task, [f.material]);
        const ao = f.material.plugins![0]!;
        const neutral = sampled(ao);
        const output = texture();
        const gpu = { visibility: output.texture, width: 128, height: 96 } as SsaoGpu;
        f.task.outputTexture._colorView = output.view;
        f.task._onOutputChanged!(gpu, f.task.outputTexture);
        const makeGroup = vi.fn(() => ({ texture: sampled(ao).texture }) as unknown as GPUBindGroup);
        const draw = vi.fn(() => 1);
        const binding: DrawBinding = {
            renderable: { order: 0, isTransparent: false, bind: () => binding },
            pipeline: {} as GPURenderPipeline,
            draw: () => 1,
        };
        const disposers: (() => void)[] = [];
        const args = [binding, f.engine, [ao], "ibl", 0, 0, makeGroup, draw, disposers, f.scene] as const;
        const main = decorate(...args);
        const secondary = decorate(...args);
        const mainContext = { _camera: f.camera, targetWidth: 128, targetHeight: 96 };
        const otherCamera = createFreeCamera({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 });
        const secondaryContext = { _camera: otherCamera, targetWidth: 64, targetHeight: 64 };
        const pass = {} as GPURenderPassEncoder;
        for (let frame = 0; frame < 3; frame++) {
            // Both updates may precede either draw; the last camera must not select both groups.
            main.update!(mainContext);
            secondary.update!(secondaryContext);
            main.draw(pass, f.engine);
            expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: output.texture }));
            secondary.draw(pass, f.engine);
            expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: neutral.texture }));
        }
        expect(makeGroup).toHaveBeenCalledTimes(2);
        secondaryContext._camera = f.camera;
        secondaryContext.targetWidth = 128;
        secondaryContext.targetHeight = 96;
        secondary.update!(secondaryContext);
        secondary.draw(pass, f.engine);
        expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: output.texture }));
        expect(makeGroup).toHaveBeenCalledTimes(3);
        secondaryContext._camera = otherCamera;
        secondary.update!(secondaryContext);
        main.update!(mainContext);
        secondary.draw(pass, f.engine);
        expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: neutral.texture }));
        expect(makeGroup).toHaveBeenCalledTimes(4);
        const replacement = texture();
        const nextGpu = { visibility: replacement.texture, width: 128, height: 96 } as SsaoGpu;
        f.task.outputTexture._colorView = replacement.view;
        f.task._onOutputChanged!(nextGpu, f.task.outputTexture);
        gpu.releaseVisibility!();
        disposeGpuResourceRetirements(f.engine);
        expect(output.texture.destroy).not.toHaveBeenCalled();
        main.update!(mainContext);
        secondary.update!(secondaryContext);
        main.draw(pass, f.engine);
        expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: replacement.texture }));
        secondary.draw(pass, f.engine);
        expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: neutral.texture }));
        disposeGpuResourceRetirements(f.engine);
        expect(output.texture.destroy).toHaveBeenCalledOnce();
        f.task.dispose();
        secondary.update!(secondaryContext);
        main.update!(mainContext);
        main.draw(pass, f.engine);
        expect(draw).toHaveBeenLastCalledWith(pass, expect.objectContaining({ texture: neutral.texture }));
        nextGpu.releaseVisibility!();
        disposers.forEach((dispose) => dispose());
        for (const dispose of f.scene._disposables) dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(neutral.texture.destroy).toHaveBeenCalledOnce();
        expect(output.texture.destroy).toHaveBeenCalledOnce();
        expect(replacement.texture.destroy).toHaveBeenCalledOnce();
    });

    it("compares plugin generations independently when pass selection changes in opposite directions", () => {
        const f = fixture();
        let first = 0,
            second = 1;
        const plugins: MaterialPlugin[] = [
            { name: "first", _bindingVersion: () => first },
            { name: "second", _bindingVersion: () => second },
        ];
        const makeGroup = vi.fn(() => ({}) as GPUBindGroup);
        const binding: DrawBinding = {
            renderable: { order: 0, isTransparent: false, bind: () => binding },
            pipeline: {} as GPURenderPipeline,
            draw: () => 1,
        };
        const disposers: (() => void)[] = [];
        const decorated = decorate(binding, f.engine, plugins, "ibl", 0, 0, makeGroup, () => 1, disposers);
        const context = { _camera: f.camera, targetWidth: 128, targetHeight: 96 };
        decorated.update!(context);
        first = 1;
        second = 0;
        decorated.update!(context);
        decorated.update!(context);
        expect(makeGroup).toHaveBeenCalledTimes(2);
        disposers.forEach((dispose) => dispose());
    });

    it("leases each renderable/pipeline once, refreshes before drawing, and retires old resources", () => {
        const f = fixture();
        const first = texture(),
            second = texture();
        let current = first,
            version = 0;
        const plugin: MaterialPlugin = { name: "dynamic", _bindingVersion: () => version, getActiveTextures: (out) => out.push(current) };
        const makeGroup = vi.fn(() => ({}) as GPUBindGroup),
            draw = vi.fn(() => 1);
        const binding: DrawBinding = {
            renderable: { order: 0, isTransparent: false, bind: () => binding },
            pipeline: {} as GPURenderPipeline,
            draw: () => 1,
        };
        const disposers: (() => void)[] = [];
        const args = [binding, f.engine, [plugin], "ibl", 0, 0, makeGroup, draw, disposers] as const;
        const a = decorate(...args),
            b = decorate(...args);
        expect(makeGroup).not.toHaveBeenCalled();
        const context = { targetWidth: 128, targetHeight: 96, _camera: f.camera };
        expect(() => a.draw({} as GPURenderPassEncoder, f.engine)).toThrow("updated before drawing");
        a.update!(context);
        b.update!(context);
        expect(makeGroup).toHaveBeenCalledOnce();
        expect(getTextureReferenceStore().get(first.texture)).toBe(1);
        current = second;
        version++;
        a.update!(context);
        b.update!(context);
        expect(makeGroup).toHaveBeenCalledTimes(2);
        a.draw({} as GPURenderPassEncoder, f.engine);
        expect(draw).toHaveBeenLastCalledWith(expect.anything(), makeGroup.mock.results[1]!.value);
        expect(first.texture.destroy).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(f.engine);
        expect(first.texture.destroy).toHaveBeenCalledOnce();
        expect(second.texture.destroy).not.toHaveBeenCalled();
        disposers.forEach((dispose) => dispose());
        disposers.forEach((dispose) => dispose());
        disposeGpuResourceRetirements(f.engine);
        expect(second.texture.destroy).toHaveBeenCalledOnce();
    });
});
