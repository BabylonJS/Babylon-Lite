import {
    addTask,
    addToScene,
    attachControl,
    buildFrameGraphTask,
    createArcRotateCamera,
    createBox,
    createCopyToTextureTask,
    createDirectionalLight,
    createEngine,
    createGeometryRendererTask,
    enableGeometryVelocity,
    createGround,
    createPbrMaterial,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSphere,
    createSsaoTask,
    enablePbrSsao,
    enableSsaoHalfResolution,
    enableSsaoMotionPruning,
    GeometryTextureType,
    getFrameGraph,
    getRenderTaskGpuTimings,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    setPbrEmissive,
    setRenderTaskGpuTimingEnabled,
    startEngine,
    pauseAnimation,
    playAnimation,
} from "babylon-lite";
import type { PbrMaterialProps, SsaoQuality } from "babylon-lite";
import { createAoDeformationExamples } from "./ambient-occlusion-deformation.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const status = document.getElementById("status")!;
    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.045, g: 0.055, b: 0.075, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2.7, 1.08, 8.5, { x: 0, y: 0.9, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 30;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const material = (color: [number, number, number]): PbrMaterialProps => {
        const result = createPbrMaterial();
        result.baseColorFactor = [...color, 1];
        result.metallicFactor = 0;
        result.roughnessFactor = 0.85;
        return result;
    };
    const white = material([0.65, 0.65, 0.65]);
    const blue = material([0.08, 0.25, 0.5]);
    const orange = material([0.6, 0.2, 0.055]);
    const floor = createGround(engine, { width: 8, height: 6 });
    floor.material = white;
    addToScene(scene, floor);
    const box = (position: [number, number, number], size: [number, number, number], mat = white): void => {
        const mesh = createBox(engine);
        mesh.position.x = position[0];
        mesh.position.y = position[1];
        mesh.position.z = position[2];
        mesh.scaling.x = size[0];
        mesh.scaling.y = size[1];
        mesh.scaling.z = size[2];
        mesh.material = mat;
        addToScene(scene, mesh);
    };
    box([0, 1.5, 2.6], [8, 3, 0.12]);
    box([-3.8, 1.5, -0.2], [0.12, 3, 5.6]);
    box([-1.2, 0.6, 0.8], [1.2, 1.2, 1.2], blue);
    box([-1.2, 1.6, 0.8], [0.8, 0.8, 0.8], orange);
    box([1.3, 0.6, 1.85], [1.7, 1.2, 0.12], orange);
    const sphere = createSphere(engine, { diameter: 1.5, segments: 32 });
    sphere.position.x = 1.3;
    sphere.position.y = 0.75;
    sphere.position.z = -0.2;
    sphere.material = blue;
    addToScene(scene, sphere);
    const glow = material([0, 0, 0]);
    setPbrEmissive(glow, [0.8, 0.28, 0.08]);
    box([-2.7, 0.2, -1.35], [0.45, 0.4, 0.45], glow);

    const deforming = document.getElementById("deforming") as HTMLInputElement;
    const examples = await createAoDeformationExamples(engine);
    addToScene(scene, examples);
    const deformationAnimations = examples.animationGroups;
    if (!deformationAnimations?.length) {
        throw new Error("AO deformation examples did not load their skin/morph animation.");
    }
    const animateDeformation = (): void => {
        for (const group of deformationAnimations) {
            group.loopAnimation = true;
            if (deforming.checked) {
                playAnimation(group);
            } else {
                pauseAnimation(group);
            }
        }
    };
    animateDeformation();
    deforming.addEventListener("change", animateDeformation);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        brdfUrl: "/brdf-lut.png",
        skipSkybox: true,
        skipGround: true,
    });
    const sun = createDirectionalLight([0.35, -1, 0.55], 0);
    addToScene(scene, sun);
    const geometry = createGeometryRendererTask(
        {
            name: "ao-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }, { type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba16float" }],
        },
        engine,
        scene
    );
    enableGeometryVelocity(geometry, { previousDepth: true });
    const useNormalTexture = document.getElementById("useNormalTexture") as HTMLInputElement;
    const historySamples = document.getElementById("historySamples") as HTMLInputElement;
    const ao = createSsaoTask(
        {
            depthTexture: geometry.geometryDepthTexture,
            normalTexture: useNormalTexture.checked ? geometry.geometryViewNormalTexture! : undefined,
            camera,
            radius: 0.6,
            temporal: {
                velocityTexture: geometry.geometryLinearVelocityTexture!,
                velocityHasPreviousDepth: true,
                historySamples: Number(historySamples.value),
            },
        },
        engine,
        scene
    );
    const temporal = ao.temporal;
    const resolution = enableSsaoHalfResolution(ao);
    const pruningToggle = document.getElementById("motionPruning") as HTMLInputElement;
    const pruning = enableSsaoMotionPruning(ao);
    pruning.enabled = pruningToggle.checked;
    pruningToggle.addEventListener("change", () => {
        pruning.enabled = pruningToggle.checked;
    });
    await enablePbrSsao(scene, ao);
    const colorTarget = createRenderTarget({ lbl: "ao-lit", format: engine.format, dFormat: "depth32float", samples: 1, size: engine });
    const color = createRenderTask({ name: "ao-lit", rt: colorTarget, clr: true }, engine, scene);
    const present = createCopyToTextureTask({ name: "ao-lit-present", sourceTexture: colorTarget, targetTexture: engine.scRT }, engine, scene);
    const visibility = createCopyToTextureTask(
        {
            name: "ao-only",
            sourceTexture: ao.outputTexture,
            targetTexture: engine.scRT,
        },
        engine,
        scene
    );
    visibility.executionEnabled = false;
    addTask(scene, geometry);
    addTask(scene, ao);
    addTask(scene, color);
    addTask(scene, present);
    addTask(scene, visibility);
    const refreshAoOutput = (): void => {
        const graph = getFrameGraph(scene);
        buildFrameGraphTask(graph, ao);
        // Full/Half and normal-mode changes can replace the texture sampled by this copy.
        buildFrameGraphTask(graph, visibility);
    };

    const quality = document.getElementById("quality") as HTMLSelectElement;
    ao.quality = quality.value as SsaoQuality;
    quality.addEventListener("change", () => {
        ao.quality = quality.value as SsaoQuality;
    });
    const enabled = document.getElementById("enabled") as HTMLInputElement;
    enabled.addEventListener("change", () => {
        ao.enabled = enabled.checked;
    });
    const temporalToggle = document.getElementById("temporal") as HTMLInputElement;
    temporal.enabled = temporalToggle.checked;
    historySamples.disabled = !temporal.enabled;
    const updateHistorySamples = (): void => {
        temporal.historySamples = Number(historySamples.value);
        document.getElementById("historySamplesValue")!.textContent = `${temporal.historySamples} (${(1 - 1 / temporal.historySamples).toFixed(4)} max history weight)`;
    };
    updateHistorySamples();
    historySamples.addEventListener("input", updateHistorySamples);
    temporalToggle.addEventListener("change", () => {
        temporal.enabled = temporalToggle.checked;
        historySamples.disabled = !temporal.enabled;
    });
    const resolutionSelect = document.getElementById("resolution") as HTMLSelectElement;
    const selectResolution = (): void => {
        if (resolutionSelect.value !== "full" && resolutionSelect.value !== "half") {
            throw new Error(`Unsupported AO resolution: ${resolutionSelect.value}`);
        }
        resolution.enabled = resolutionSelect.value !== "full";
    };
    selectResolution();
    const updateStatus = (): void => {
        status.textContent = `${resolution.active ? "Half-resolution AO estimation and temporal reconstruction" : resolution.enabled ? "Full-resolution AO (half-mode viewport safeguard)" : "Full-resolution AO"} · Normals: ${ao.normalTexture ? "texture" : "reconstructed from depth"} · Full-resolution scene and AO output · Drag to orbit, wheel to zoom`;
    };
    useNormalTexture.addEventListener("change", () => {
        ao.normalTexture = useNormalTexture.checked ? geometry.geometryViewNormalTexture! : null;
        refreshAoOutput();
        updateStatus();
    });
    resolutionSelect.addEventListener("change", () => {
        selectResolution();
        refreshAoOutput();
        updateStatus();
    });
    const moving = document.getElementById("moving") as HTMLInputElement;
    const gpuTiming = document.getElementById("gpuTiming") as HTMLInputElement;
    const gpuTimingValues = document.getElementById("gpuTimingValues")!;
    let timingError: string | undefined;
    let timingRefreshMs = 0;
    let timingFrame = -1;
    const timingSamples: { name: string; index: number; sum: number; count: number }[] = [];
    const collectGpuTimings = (): void => {
        if (!gpuTiming.checked || timingError) {
            return;
        }
        const snapshot = getRenderTaskGpuTimings(engine);
        if (snapshot.status !== "available" || snapshot.frameIndex === timingFrame) {
            return;
        }
        timingFrame = snapshot.frameIndex;
        for (let i = 0; i < snapshot.tasks.length; i++) {
            const task = snapshot.tasks[i]!;
            let sample = timingSamples[i];
            if (!sample || sample.name !== task.name || sample.index !== task.index) {
                sample = { name: task.name, index: task.index, sum: 0, count: 0 };
                timingSamples[i] = sample;
            }
            sample.sum += task.durationMs;
            sample.count++;
        }
        timingSamples.length = snapshot.tasks.length;
    };
    const updateGpuTimings = (): void => {
        const timings = getRenderTaskGpuTimings(engine);
        gpuTimingValues.dataset.status = timingError ? "error" : timings.status;
        if (timingError) {
            gpuTimingValues.textContent = `GPU timing error: ${timingError}`;
        } else if (timings.status === "unsupported") {
            gpuTimingValues.textContent = "GPU timestamp queries are not supported by this device.";
        } else if (timings.status === "disabled") {
            gpuTimingValues.textContent = "GPU profiling disabled.";
        } else if (timings.status === "pending") {
            gpuTimingValues.textContent = "Waiting for GPU timestamp readback...";
        } else if (timings.status === "error") {
            gpuTimingValues.textContent = `GPU timing error: ${timings.error}`;
        } else {
            let total = 0;
            const lines: string[] = [];
            for (let i = 0; i < timings.tasks.length; i++) {
                const task = timings.tasks[i]!;
                const sample = timingSamples[i];
                const duration = sample && sample.name === task.name && sample.index === task.index && sample.count ? sample.sum / sample.count : task.durationMs;
                total += duration;
                lines.push(`${task.name}: ${duration.toFixed(3)} ms`);
                if (sample) {
                    sample.sum = 0;
                    sample.count = 0;
                }
            }
            lines.push(`Timed tasks total: ${total.toFixed(3)} ms`);
            if (timings.droppedTaskCount) {
                lines.push(`Untimed tasks: ${timings.droppedTaskCount}`);
            }
            gpuTimingValues.textContent = lines.join("\n");
        }
    };
    const configureGpuTiming = async (): Promise<void> => {
        gpuTiming.disabled = true;
        timingError = undefined;
        timingFrame = -1;
        timingSamples.length = 0;
        try {
            await setRenderTaskGpuTimingEnabled(engine, gpuTiming.checked);
        } catch (error) {
            console.error(error);
            timingError = String(error);
            gpuTiming.checked = false;
            await setRenderTaskGpuTimingEnabled(engine, false);
        } finally {
            const timings = getRenderTaskGpuTimings(engine);
            gpuTiming.disabled = !timings.supported;
            if (!timings.supported) {
                gpuTiming.checked = false;
            }
            updateGpuTimings();
        }
    };
    gpuTiming.addEventListener("change", () => {
        void configureGpuTiming().catch((error: unknown) => {
            console.error(error);
            timingError = String(error);
            updateGpuTimings();
        });
    });
    let time = 0;
    let activeResolution = resolution.active;
    onBeforeRender(scene, (deltaMs) => {
        collectGpuTimings();
        if (activeResolution !== resolution.active) {
            activeResolution = resolution.active;
            updateStatus();
        }
        if (moving.checked) {
            time += deltaMs * 0.001;
            sphere.position.x = 1.3 + Math.sin(time) * 0.7;
        }
        timingRefreshMs += deltaMs;
        if (timingRefreshMs >= 250) {
            timingRefreshMs = 0;
            updateGpuTimings();
        }
    });
    const aoOnly = document.getElementById("aoOnly") as HTMLInputElement;
    aoOnly.addEventListener("change", () => {
        visibility.executionEnabled = aoOnly.checked;
        color.executionEnabled = !aoOnly.checked;
        present.executionEnabled = !aoOnly.checked;
    });
    const direct = document.getElementById("direct") as HTMLInputElement;
    direct.addEventListener("change", () => {
        sun.intensity = direct.checked ? 1.2 : 0;
    });
    for (const name of ["radius", "intensity"] as const) {
        const input = document.getElementById(name) as HTMLInputElement;
        input.addEventListener("input", () => {
            ao[name] = Number(input.value);
            document.getElementById(`${name}Value`)!.textContent = input.value;
        });
    }
    await registerScene(scene);
    await configureGpuTiming();
    await startEngine(engine);
    canvas.dataset.ready = "true";
    updateStatus();
}

void main().catch((error: unknown) => {
    console.error(error);
    document.getElementById("status")!.textContent = String(error);
    document.getElementById("renderCanvas")!.dataset.error = String(error);
});
