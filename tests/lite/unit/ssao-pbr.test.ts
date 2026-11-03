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
import { enablePbrSsao } from "../../../packages/babylon-lite/src/post-process/ssao-pbr.js";
import type { SsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import type { DrawBinding } from "../../../packages/babylon-lite/src/render/renderable.js";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { getTextureReferenceStore } from "../../../packages/babylon-lite/src/resource/texture-reference-store.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";

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
