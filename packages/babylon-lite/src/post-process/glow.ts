import type { Camera } from "../camera/camera.js";
import { _applyCameraViewport, _cameraChangeKey, getProjectionMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { F32 } from "../engine/typed-arrays.js";
import type { Task } from "../frame-graph/task.js";
import { _packSceneUniforms } from "../frame-graph/scene-uniforms-pack.js";
import type { Material } from "../material/material.js";
import { getMaterialSource } from "../material/material-view.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Mat4Storage } from "../math/types.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import { createEmptyUniformBuffer } from "../resource/empty-uniform-buffer.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState, getLightsUboSize, _writeTaskLightsData } from "../render/scene-lights-ubo.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import type { GlowColor } from "../material/glow/glow-source.js";
import { readGlowSurface } from "../material/glow/glow-source.js";
import type { GlowMaterialContext, GlowMaterialDraw } from "../material/glow/glow-material.js";
import { createGlowDraw, disposeGlowDraw, drawGlowMaterial, preloadGlowMaterials, updateGlowDraw } from "../material/glow/glow-material.js";
import { createGlowMerge } from "../material/glow/glow-merge.js";
import { createBlurPostProcessTask } from "./blur.js";

export type { GlowColor } from "../material/glow/glow-source.js";

/** Source-surface color override. The result is reused; do not retain it. */
export type GlowEmissiveColorSelector = (mesh: Mesh, material: Material, result: GlowColor) => void;
/** Returning null explicitly suppresses the material's emissive texture. */
export type GlowEmissiveTextureSelector = (mesh: Mesh, material: Material) => Texture2D | null;

/** Selective emissive rendering and Gaussian glow over a borrowed color destination. */
export interface GlowPostProcessTaskConfig {
    name?: string;
    targetTexture: RenderTarget;
    resolveTexture?: RenderTarget;
    meshes?: readonly Mesh[];
    camera?: Camera | null;
    mainTextureRatio?: number;
    mainTextureFixedSize?: number;
    /** Babylon texture type: 0 = unsigned byte (default), 2 = half float. */
    mainTextureType?: number;
    /** Babylon texture format: 5 = RGBA. */
    mainTextureFormat?: number;
    blurKernelSize?: number;
    intensity?: number;
    isEnabled?: boolean;
    neutralColor?: GlowColor;
    alphaBlendingMode?: number;
    ldrMerge?: boolean;
    excludeByDefault?: boolean;
    customEmissiveColorSelector?: GlowEmissiveColorSelector;
    customEmissiveTextureSelector?: GlowEmissiveTextureSelector;
}

/** One compound frame-graph task: emissive geometry, four blurs, then additive composition. */
export interface GlowPostProcessTask extends Task {
    readonly outputTexture: RenderTarget;
    readonly resolveTexture: RenderTarget | undefined;
    readonly emissiveTexture: RenderTarget;
    readonly blurredTextures: readonly [RenderTarget, RenderTarget];
    meshes: readonly Mesh[] | undefined;
    camera: Camera | null;
    intensity: number;
    isEnabled: boolean;
    blurKernelSize: number;
    neutralColor: GlowColor;
    excludeByDefault: boolean;
    readonly includedOnlyMeshes: Set<Mesh>;
    readonly excludedMeshes: Set<Mesh>;
    customEmissiveColorSelector: GlowEmissiveColorSelector | undefined;
    customEmissiveTextureSelector: GlowEmissiveTextureSelector | undefined;
}

/** Create a glow task. Schedule it after the destination's producer; destinations are borrowed. */
export function createGlowPostProcessTask(config: GlowPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): GlowPostProcessTask {
    const target = config.targetTexture;
    const resolve = config.resolveTexture;
    const type = config.mainTextureType ?? 0;
    const ratio = config.mainTextureRatio ?? 0.5;
    const fixed = config.mainTextureFixedSize ?? 0;
    const initialKernel = config.blurKernelSize ?? 32;
    if (!(initialKernel > 0) || !Number.isFinite(initialKernel)) {
        throw new Error("GlowPostProcessTask requires a positive finite blurKernelSize.");
    }
    if (!target._descriptor.format) {
        throw new Error("GlowPostProcessTask requires a color targetTexture.");
    }
    if (type !== 0 && type !== 2) {
        throw new Error("GlowPostProcessTask mainTextureType must be 0 (unsigned byte) or 2 (half float).");
    }
    if ((config.mainTextureFormat ?? 5) !== 5) {
        throw new Error("GlowPostProcessTask supports RGBA mainTextureFormat (5).");
    }
    if (!(ratio > 0) || !Number.isFinite(ratio) || fixed < 0 || !Number.isFinite(fixed)) {
        throw new Error("GlowPostProcessTask requires a positive finite ratio and a nonnegative finite fixed size.");
    }
    if (
        resolve &&
        ((target._descriptor.samples ?? 1) === 1 || resolve === target || resolve._descriptor.samples !== 1 || resolve._descriptor.format !== target._descriptor.format)
    ) {
        throw new Error("GlowPostProcessTask resolveTexture requires a distinct, matching single-sample target for an MSAA output.");
    }
    const name = config.name ?? "glow";
    const mapSize = { width: 1, height: 1 };
    const smallSize = { width: 1, height: 1 };
    const emissive = createRenderTarget({ lbl: `${name}-emissive`, format: type === 2 ? "rgba16float" : "rgba8unorm", dFormat: "depth32float", samples: 1, size: mapSize });
    const targets = [0, 1, 2, 3].map((i) => createRenderTarget({ lbl: `${name}-blur-${i}`, format: "rgba16float", samples: 1, size: i < 2 ? mapSize : smallSize }));
    const blurs = targets.map((output, i) =>
        createBlurPostProcessTask(
            {
                name: `${name}-blur-${i}`,
                sourceTexture: i === 0 ? emissive : targets[i - 1]!,
                targetTexture: output,
                direction: { x: i % 2 === 0 ? 1 : 0, y: i % 2 },
                kernel: initialKernel / 2,
            },
            engine,
            scene
        )
    );
    const blurred: readonly [RenderTarget, RenderTarget] = [targets[1]!, targets[3]!];
    const mode = config.alphaBlendingMode ?? 1;
    const merge = createGlowMerge(engine, blurred, target, resolve, mode, config.ldrMerge ?? false);
    // Through these modes a black map adds nothing and leaves destination alpha, so an empty map is skippable.
    const additive = mode === 1 || mode === 6;
    const context: GlowMaterialContext = {
        engine,
        scene,
        format: emissive._descriptor.format!,
        variants: new Map(),
        programs: new Map(),
        targetTexture: null,
        frame: 0,
        skeleton: null,
        morph: null,
        instances: null,
        syncInstances: null,
        updateInstances: null,
        node: null,
        loading: null,
        disposed: false,
    };
    const draws = new Map<Mesh, GlowMaterialDraw>();
    const retained: GlowMaterialDraw[] = [];
    const opaque: GlowMaterialDraw[] = [];
    const tested: GlowMaterialDraw[] = [];
    const blended: GlowMaterialDraw[] = [];
    let order: GlowMaterialDraw[] = [];
    let recorded: GlowMaterialDraw[] = [];
    const bundles: GPURenderBundle[] = [];
    const removed = new WeakSet<Mesh>();
    const cameraScene: SceneContext = Object.create(scene);
    const packWorld = engine._makePackMeshWorld?.(cameraScene) ?? packMat4IntoF32;
    const floating = packWorld !== packMat4IntoF32;
    const sceneData = new F32(SCENE_UBO_BYTES / 4);
    // Inputs of the last scene-UBO upload, keyed as the forward pass keys its own.
    const sceneKey: unknown[] = [];
    let sceneBuffer: GPUBuffer | null = null;
    let sceneGroup: GPUBindGroup | null = null;
    // Shared scene lights, the lights bound in the scene group, and task-owned lights relative to a camera override.
    let sceneLights: GPUBuffer | null = null;
    let boundLights: GPUBuffer | null = null;
    let ownLights: GPUBuffer | null = null;
    let ownLightsData: Float32Array | null = null;
    let appliedTextureSelector = config.customEmissiveTextureSelector;
    let device: GPUDevice | null = null;
    let aspect = 1;
    let frame = 0;
    // Bumped by recording and by scene renderable changes: every draw then re-reads its source surface.
    let epoch = 0;
    let bundleEpoch = -1;
    let renderableVersion = NaN;
    // Floating-origin view epoch: mesh worlds are packed relative to the camera position.
    let view = 0;
    let viewCamera: Camera | null = null;
    let viewVersion = NaN;
    // Neutral alpha already held by every output after an empty frame, or NaN.
    let idleAlpha = NaN;
    let disposed = false;
    let kernel = initialKernel;
    const color: GPURenderPassColorAttachment = { view: undefined!, loadOp: "clear", storeOp: "store" };
    const depth: GPURenderPassDepthStencilAttachment = { view: undefined!, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "discard" };
    const passDescriptor: GPURenderPassDescriptor = { label: `${name}-emissive`, colorAttachments: [color], depthStencilAttachment: depth };

    const recordBundle = (): void => {
        const encoder = engine._device.createRenderBundleEncoder({ label: `${name}-emissive`, colorFormats: [context.format], depthStencilFormat: "depth32float" });
        encoder.setBindGroup(0, sceneGroup!);
        let last: GPURenderPipeline | null = null;
        for (const draw of recorded) {
            const pipeline = draw.pipeline!;
            if (pipeline !== last) {
                last = pipeline;
                encoder.setPipeline(pipeline);
            }
            drawGlowMaterial(context, draw, encoder);
        }
        bundles[0] = encoder.finish();
    };

    const writeSceneUniforms = (camera: Camera, projection: number): void => {
        const key = _cameraChangeKey(camera);
        const fog = scene.fog;
        const image = scene.imageProcessing;
        const env = scene._envTextures;
        // NodeMaterial glow programs read the same scene uniforms as their forward pass, so they share its change key.
        if (
            sceneKey[0] === camera &&
            sceneKey[1] === key &&
            sceneKey[2] === projection &&
            sceneKey[3] === fog &&
            sceneKey[4] === image.exposure &&
            sceneKey[5] === image.contrast &&
            sceneKey[6] === env
        ) {
            return;
        }
        sceneKey[0] = camera;
        sceneKey[1] = key;
        sceneKey[2] = projection;
        sceneKey[3] = fog;
        sceneKey[4] = image.exposure;
        sceneKey[5] = image.contrast;
        sceneKey[6] = env;
        _packSceneUniforms(sceneData, engine, scene, camera, projection);
        for (const contributor of scene._sceneUboContributors ?? []) {
            contributor(sceneData, scene);
        }
        if (floating) {
            // Mesh worlds are packed relative to this camera, which may not carry the scene's floating-origin flag.
            sceneData[28] = sceneData[29] = sceneData[30] = 0;
            multiplyMat4IntoBuffer(
                sceneData as unknown as Mat4Storage,
                0,
                getProjectionMatrix(camera, projection) as unknown as Mat4Storage,
                0,
                sceneData as unknown as Mat4Storage,
                16
            );
        }
        engine._device.queue.writeBuffer(sceneBuffer!, 0, sceneData as Float32Array<ArrayBuffer>);
    };

    const task: GlowPostProcessTask = {
        name,
        engine,
        scene,
        _passes: [],
        outputTexture: target,
        resolveTexture: resolve,
        emissiveTexture: emissive,
        blurredTextures: blurred,
        meshes: config.meshes,
        camera: config.camera ?? null,
        intensity: config.intensity ?? 1,
        isEnabled: config.isEnabled ?? true,
        blurKernelSize: kernel,
        neutralColor: config.neutralColor ?? { r: 0, g: 0, b: 0, a: 1 },
        excludeByDefault: config.excludeByDefault ?? false,
        includedOnlyMeshes: new Set(),
        excludedMeshes: new Set(),
        customEmissiveColorSelector: config.customEmissiveColorSelector,
        customEmissiveTextureSelector: config.customEmissiveTextureSelector,
        // Scene-uniform writers that bypass the change key (environment rotation/blur, clip plane, sky) reset it.
        _sceneUboCacheKey: sceneKey,
        async _preload(): Promise<void> {
            await preloadGlowMaterials(context, task.meshes ?? scene.meshes);
        },
        _removeMesh(value: object): void {
            const mesh = value as Mesh;
            removed.add(mesh);
            const draw = draws.get(mesh);
            if (draw) {
                disposeGlowDraw(context, draw);
                draws.delete(mesh);
            }
        },
        record(): void {
            if (disposed) {
                throw new Error("GlowPostProcessTask has been disposed.");
            }
            const dimensions = target === scene.surface.scRT ? scene.surface.canvas : (target._resolveSize?.(target._descriptor) ?? target._descriptor.size);
            if (!("width" in dimensions) || !("height" in dimensions)) {
                throw new Error("GlowPostProcessTask could not resolve the destination dimensions.");
            }
            // The map is sampled in destination screen space, so it is projected with the destination aspect even when fixed-size.
            aspect = dimensions.width / dimensions.height;
            mapSize.width = fixed ? Math.max(2, Math.floor(fixed)) : Math.max(1, Math.floor(dimensions.width * ratio));
            mapSize.height = fixed ? Math.max(2, Math.floor(fixed)) : Math.max(1, Math.floor(dimensions.height * ratio));
            smallSize.width = Math.max(1, mapSize.width >> 1);
            smallSize.height = Math.max(1, mapSize.height >> 1);
            if (device !== engine._device) {
                for (const draw of draws.values()) {
                    disposeGlowDraw(context, draw);
                }
                draws.clear();
                retained.length = 0;
                recorded.length = 0;
                context.variants.clear();
                // Programs prepared before the first recording already belong to the current device.
                context.node?.disposeGlowNodePrograms(context, engine._device);
                sceneBuffer?.destroy();
                ownLights?.destroy();
                ownLights = ownLightsData = null;
                device = engine._device;
                sceneBuffer = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
            }
            // The scene group binds these lights, or task-owned ones, on the next execution.
            sceneLights = ensureSceneLightState(engine, scene)._buffer;
            boundLights = null;
            buildRenderTarget(emissive, engine);
            context.targetTexture = emissive._colorTexture;
            color.view = emissive._colorView!;
            depth.view = emissive._depthView!;
            for (const blur of blurs) {
                blur.record();
            }
            merge.record();
            epoch++;
            sceneKey.length = 0;
            idleAlpha = NaN;
        },
        execute(): number {
            if (!task.isEnabled || task.executionEnabled === false) {
                return 0;
            }
            if (disposed) {
                throw new Error("GlowPostProcessTask has been disposed.");
            }
            const included = task.includedOnlyMeshes;
            // Babylon skips the whole layer, merge included, when nothing can be selected.
            if (task.excludeByDefault && !included.size) {
                return 0;
            }
            const camera = task.camera ?? scene.camera;
            if (!camera) {
                throw new Error("GlowPostProcessTask requires a camera.");
            }
            if (!Number.isFinite(task.intensity) || !(task.blurKernelSize > 0) || !Number.isFinite(task.blurKernelSize)) {
                throw new Error("GlowPostProcessTask requires finite intensity and a positive finite blurKernelSize.");
            }
            const viewport = camera.viewport;
            writeSceneUniforms(camera, aspect * (viewport ? viewport.width / viewport.height : 1));
            cameraScene.camera = camera;
            if (floating && (viewCamera !== camera || viewVersion !== camera.worldMatrixVersion)) {
                viewCamera = camera;
                viewVersion = camera.worldMatrixVersion;
                view++;
            }
            // Mesh, material-family and texture replacements arrive through scene renderable rebuilds.
            const changed = scene._renderableVersion !== renderableVersion;
            if (changed) {
                renderableVersion = scene._renderableVersion;
                epoch++;
            }
            const textureSelector = task.customEmissiveTextureSelector;
            if (textureSelector !== appliedTextureSelector) {
                // Surfaces cache the selected texture: a replaced or removed selector must not leave its overrides.
                appliedTextureSelector = textureSelector;
                epoch++;
            }
            // Under floating origin, positional lights must share a camera override's origin, as mesh worlds and the
            // view do. Only NodeMaterial glow programs read them; the shared buffer follows the scene camera.
            let lights = sceneLights!;
            if (floating && camera !== scene.camera && context.programs.size) {
                const floats = getLightsUboSize() / 4;
                if (ownLightsData?.length !== floats) {
                    const previous = ownLights;
                    retireGpuResources(engine, () => previous?.destroy());
                    ownLightsData = new F32(floats);
                    ownLights = createEmptyUniformBuffer(engine, floats * 4, `${name}-lights`);
                }
                _writeTaskLightsData(engine, ownLightsData, cameraScene);
                engine._device.queue.writeBuffer(ownLights!, 0, ownLightsData as Float32Array<ArrayBuffer>);
                lights = ownLights!;
            }
            if (lights !== boundLights) {
                boundLights = lights;
                sceneGroup = engine._device.createBindGroup({
                    layout: getSceneBindGroupLayout(engine),
                    entries: [
                        { binding: 0, resource: { buffer: sceneBuffer! } },
                        { binding: 1, resource: { buffer: lights } },
                    ],
                });
                // The recorded bundle binds the previous scene group.
                bundleEpoch = -1;
            }
            context.frame = ++frame;
            opaque.length = 0;
            tested.length = 0;
            blended.length = 0;
            const custom = task.meshes;
            const excluded = task.excludedMeshes;
            const colorSelector = task.customEmissiveColorSelector;
            const neutral = task.neutralColor;
            let rebound = false;
            for (const mesh of custom ?? scene.meshes) {
                let draw = draws.get(mesh);
                if (draw) {
                    if (draw.seen === frame) {
                        continue;
                    }
                    draw.seen = frame;
                } else if (custom && removed.has(mesh)) {
                    // A caller-owned list may keep a removed mesh; re-adding it to the scene bumps the renderable version.
                    if (!changed || !scene.meshes.includes(mesh)) {
                        continue;
                    }
                    removed.delete(mesh);
                }
                const material = mesh.material;
                if (!material || mesh.visible === false || mesh._skipColorDraw || excluded.has(mesh) || (included.size !== 0 && !included.has(mesh))) {
                    continue;
                }
                if (!draw) {
                    draw = createGlowDraw(context, mesh);
                    draw.seen = frame;
                    draws.set(mesh, draw);
                    retained.push(draw);
                }
                const surface = draw.surface;
                const version = getMaterialSource(material)._uboVersion;
                let refresh = draw.material !== material || draw.version !== version || draw.epoch !== epoch;
                if (refresh) {
                    readGlowSurface(material, surface, !!mesh.hasVertexAlpha && !!mesh._gpu.colorBuffer);
                    draw.material = material;
                    draw.version = version;
                    draw.epoch = epoch;
                }
                let glow = surface.neutral ? neutral : surface.color;
                // A NodeMaterial rendered by its own shader outputs its glow input; selectors do not apply to it.
                if (colorSelector && !surface.own) {
                    const source = glow;
                    glow = draw.color;
                    glow.r = source.r;
                    glow.g = source.g;
                    glow.b = source.b;
                    glow.a = source.a;
                    colorSelector(mesh, material, glow);
                }
                if (textureSelector && !surface.own) {
                    const texture = textureSelector(mesh, material) ?? null;
                    if (texture !== surface.textures[2]) {
                        surface.textures[2] = texture;
                        refresh = true;
                    }
                }
                if (draw.disposed) {
                    continue;
                }
                const state = updateGlowDraw(context, draw, refresh, glow, packWorld, view);
                if (state < 0) {
                    draw.material = null;
                    continue;
                }
                rebound = rebound || state > 0;
                (surface.alphaBlend ? blended : surface.alphaTest ? tested : opaque).push(draw);
            }
            let kept = 0;
            for (const draw of retained) {
                if (draw.seen !== frame || draw.disposed) {
                    disposeGlowDraw(context, draw);
                    if (draws.get(draw.mesh) === draw) {
                        draws.delete(draw.mesh);
                    }
                } else {
                    retained[kept++] = draw;
                }
            }
            retained.length = kept;
            const count = opaque.length + tested.length + blended.length;
            const idle = count === 0 && additive && neutral.r === 0 && neutral.g === 0 && neutral.b === 0;
            if (idle && idleAlpha === neutral.a) {
                return 0;
            }
            // Opaque, alpha-tested, then unsorted transparent surfaces, as in the reference glow map.
            order.length = 0;
            for (const draw of opaque) {
                order.push(draw);
            }
            for (const draw of tested) {
                order.push(draw);
            }
            for (const draw of blended) {
                order.push(draw);
            }
            let stale = rebound || bundleEpoch !== epoch || order.length !== recorded.length;
            for (let i = 0; !stale && i < count; i++) {
                stale = order[i] !== recorded[i];
            }
            if (stale) {
                const previous = recorded;
                recorded = order;
                order = previous;
                bundleEpoch = epoch;
                bundles.length = 0;
                if (count) {
                    recordBundle();
                }
            }
            color.clearValue = neutral;
            const pass = engine._currentEncoder.beginRenderPass(passDescriptor);
            if (count) {
                _applyCameraViewport(pass, camera, mapSize.width, mapSize.height);
                pass.executeBundles(bundles);
            }
            pass.end();
            if (kernel !== task.blurKernelSize) {
                kernel = task.blurKernelSize;
                for (const blur of blurs) {
                    blur.kernel = kernel / 2;
                    blur.updateUniforms();
                }
            }
            let passes = 0;
            for (const blur of blurs) {
                passes += blur.execute?.() ?? 0;
            }
            idleAlpha = idle ? neutral.a : NaN;
            return count + passes + merge.execute(task.intensity);
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            context.disposed = true;
            for (const draw of draws.values()) {
                disposeGlowDraw(context, draw);
            }
            draws.clear();
            retained.length = 0;
            opaque.length = 0;
            tested.length = 0;
            blended.length = 0;
            order.length = 0;
            recorded.length = 0;
            bundles.length = 0;
            context.variants.clear();
            context.node?.disposeGlowNodePrograms(context);
            sceneBuffer?.destroy();
            sceneBuffer = null;
            sceneGroup = null;
            ownLights?.destroy();
            ownLights = ownLightsData = sceneLights = boundLights = null;
            for (const blur of blurs) {
                blur.dispose();
            }
            merge.dispose();
            disposeRenderTarget(emissive);
            for (const output of targets) {
                disposeRenderTarget(output);
            }
        },
    };
    return task;
}
