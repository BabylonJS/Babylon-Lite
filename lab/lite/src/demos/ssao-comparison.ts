import {
    addTask,
    attachControl,
    createCopyToTextureTask,
    createEffectRenderTask,
    createEffectWrapper,
    createEngine,
    createGeometryRendererTask,
    enableGeometryVelocity,
    createRenderTask,
    createSceneContext,
    createSsaoTask,
    createSurfaceRenderTargetTexture,
    disposeEffectWrapper,
    disposeRenderTargetTexture,
    disposeScene,
    enableSsaoHalfResolution,
    enableSsaoHalfPipeline,
    enableSsaoMotionPruning,
    enableSsaoTemporal,
    GeometryTextureType,
    getRenderTaskGpuTimings,
    onBeforeRender,
    onRenderTargetTextureResize,
    registerScene,
    resetSsaoTemporal,
    setEffectTexture,
    setEffectUniforms,
    setRenderTaskGpuTimingEnabled,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { GeometryRendererTextureDescription, SsaoQuality } from "babylon-lite";
import { createScreenSpaceAmbientOcclusionPostProcessTask } from "ssao-comparison-baseline";
import { comparisonPassSelection, parseSsaoComparisonConfig, SSAO_BASELINE, SSAO_COMPARISON_SCENES } from "../shared/ssao-comparison-contract.js";
import { createComparisonScene, resetComparisonScene, setComparisonAnimation } from "./ssao-comparison-scenes.js";
import { COMPARISON_FRAGMENT, COMPARISON_VERTEX } from "./ssao-comparison-shader.js";

async function main(): Promise<void> {
    const config = parseSsaoComparisonConfig(new URLSearchParams(location.search));
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const status = document.getElementById("status")!;
    const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
    const input = (id: string) => document.getElementById(id) as HTMLInputElement;
    const sceneSelect = select("scene"),
        mode = select("mode"),
        algorithm = select("algorithm"),
        quality = select("quality");
    const aoOnly = input("aoOnly"),
        ssaoEnabled = input("ssaoEnabled"),
        animate = input("animate"),
        sweep = input("sweep"),
        timing = input("timing");
    const radius = input("radius"),
        intensity = input("intensity"),
        divider = input("divider");
    for (const preset of SSAO_COMPARISON_SCENES) {
        sceneSelect.add(new Option(preset.name, preset.id));
    }
    sceneSelect.value = config.scene;
    mode.value = config.mode;
    algorithm.value = config.algorithm;
    quality.value = config.quality;
    select("reconstruction").value = config.reconstruction;
    select("reconstruction").disabled = !config.half;
    aoOnly.checked = config.aoOnly;
    ssaoEnabled.checked = config.enabled;
    input("temporal").checked = config.temporal;
    input("normals").checked = config.normals;
    input("half").checked = config.half;
    input("pruning").checked = config.pruning;
    radius.value = String(config.radius);
    intensity.value = String(config.intensity);
    document.getElementById("baselineRef")!.textContent = SSAO_BASELINE.commit.slice(0, 7);
    const sourceLink = document.getElementById("baselineLink") as HTMLAnchorElement;
    sourceLink.href = SSAO_BASELINE.pullRequest;

    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.06, g: 0.075, b: 0.09, a: 1 };
    const actors = await createComparisonScene(engine, scene, config.scene);
    const camera = actors.camera;
    attachControl(camera, canvas, scene);
    animate.disabled = !actors.sphere && !actors.animations.length;
    animate.checked = !animate.disabled;
    setComparisonAnimation(actors, animate.checked);

    const color = createSurfaceRenderTargetTexture(engine, { lbl: "comparison-color", format: engine.format, dFormat: "depth32float", samples: 1, size: engine });
    const currentRelay = createSurfaceRenderTargetTexture(engine, { lbl: "comparison-current", format: "rgba16float", samples: 1, size: engine });
    const existingRelay = createSurfaceRenderTargetTexture(engine, { lbl: "comparison-existing", format: "rgba16float", samples: 1, size: engine });
    const colorTask = createRenderTask({ name: "inputs-existing", rt: color.rt, clr: true, clrColor: scene.clearColor }, engine, scene);
    const descriptions: GeometryRendererTextureDescription[] = [];
    if (config.temporal) {
        descriptions.push({ type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba16float" });
    }
    if (config.normals) {
        descriptions.push({ type: GeometryTextureType.VIEW_NORMAL });
    }
    const geometry = descriptions.length
        ? createGeometryRendererTask(
              {
                  name: "inputs-xegtao",
                  samples: 1,
                  depthTexture: color.rt,
                  targetTexture: color.rt,
                  targetTextureClearColor: scene.clearColor,
                  textureDescriptions: descriptions,
              },
              engine,
              scene
          )
        : null;
    if (geometry && config.temporal) {
        enableGeometryVelocity(geometry, { previousDepth: true });
    }
    const current = createSsaoTask(
        {
            name: "ao-xegtao",
            depthTexture: color.rt,
            normalTexture: config.normals ? geometry!.geometryViewNormalTexture! : undefined,
            camera,
            quality: config.quality,
            radius: config.radius,
            intensity: 1,
        },
        engine,
        scene
    );
    const temporal = config.temporal
        ? enableSsaoTemporal(current, {
              velocityTexture: geometry!.geometryLinearVelocityTexture!,
              velocityHasPreviousDepth: true,
              historySamples: 16,
          })
        : null;
    const pruning = temporal ? enableSsaoMotionPruning(current) : null;
    input("pruning").disabled = !pruning;
    if (pruning) {
        pruning.enabled = config.pruning;
        input("pruning").addEventListener("change", () => {
            config.pruning = pruning.enabled = input("pruning").checked;
        });
    }
    const resolution = config.reconstruction === "half" ? enableSsaoHalfPipeline(current) : enableSsaoHalfResolution(current);
    resolution.enabled = config.half;
    const existing = createScreenSpaceAmbientOcclusionPostProcessTask(
        {
            name: "ao-pr839",
            sourceTexture: color.rt,
            depthTexture: color.rt,
            camera,
            composition: "none",
            resolutionScale: config.half ? 0.5 : 1,
            radius: config.radius,
            temporalSamples: 16,
            temporalWeight: config.temporal ? 1 / 16 : 1,
        },
        engine,
        scene
    );
    const copyCurrent = createCopyToTextureTask(
        { name: "present-xegtao-relay", sourceTexture: current.outputTexture, targetTexture: currentRelay.rt, ownsTargetTexture: true },
        engine,
        scene
    );
    const copyExisting = createCopyToTextureTask(
        { name: "present-pr839-relay", sourceTexture: existing.occlusionTexture, targetTexture: existingRelay.rt, ownsTargetTexture: true },
        engine,
        scene
    );
    const effect = createEffectWrapper(engine, {
        name: "comparison-display",
        vertexWGSL: COMPARISON_VERTEX,
        fragmentWGSL: COMPARISON_FRAGMENT,
        bindings: [
            { binding: 0, name: "color", kind: "texture" },
            { binding: 1, name: "current", kind: "texture" },
            { binding: 2, name: "existing", kind: "texture" },
            { binding: 3, name: "linear", kind: "sampler", textureBinding: "color" },
            { binding: 4, name: "options", kind: "uniform", uniformByteLength: 32 },
        ],
    });
    const compositor = createEffectRenderTask({ name: "present-common-composite", effect, target: engine.scRT, clear: true }, engine, scene);
    const rebind = () => {
        setEffectTexture(effect, "color", color.texture);
        setEffectTexture(effect, "current", currentRelay.texture);
        setEffectTexture(effect, "existing", existingRelay.texture);
    };
    rebind();
    addTask(scene, colorTask);
    if (geometry) {
        addTask(scene, geometry);
    }
    addTask(scene, current);
    addTask(scene, existing);
    addTask(scene, copyCurrent);
    addTask(scene, copyExisting);
    addTask(scene, compositor);

    const options = new Float32Array(8);
    let warmFrames = 0,
        lastTimingFrame = -1,
        refreshMs = 0,
        timingEpoch = 0,
        objectTime = 0,
        cameraTime = 0;
    const totals: { name: string; sum: number; count: number }[] = [];
    const clearHistory = () => {
        if (temporal) {
            resetSsaoTemporal(temporal);
        }
        existing.resetVersion++;
        warmFrames = 0;
        lastTimingFrame = -1;
        totals.length = 0;
    };
    const cancelResize = [color, currentRelay, existingRelay].map((target) =>
        onRenderTargetTextureResize(target, () => {
            rebind();
            clearHistory();
        })
    );
    const updateDisplay = () => {
        options[0] = config.algorithm === "current" ? 0 : 1;
        options[1] = config.mode === "split" ? 1 : 0;
        options[2] = aoOnly.checked ? 1 : 0;
        options[3] = Number(divider.value);
        options[4] = Number(intensity.value);
        options[5] = config.enabled ? 0 : 1;
        setEffectUniforms(effect, options);
        document.getElementById("intensityValue")!.textContent = intensity.value;
        document.getElementById("radiusValue")!.textContent = radius.value;
        document.getElementById("laneLabel")!.textContent = !config.enabled
            ? "SSAO disabled"
            : config.mode === "split"
              ? "Left: XeGTAO | Right: BLite PR #839"
              : config.algorithm === "current"
                ? "XeGTAO"
                : "BLite PR #839";
    };
    const applySelection = () => {
        const active = comparisonPassSelection(config);
        current.executionEnabled = active.current;
        existing.executionEnabled = active.existing;
        colorTask.executionEnabled = !geometry || active.color;
        if (geometry) {
            geometry.executionEnabled = active.geometry;
        }
        copyCurrent.executionEnabled = active.current;
        copyExisting.executionEnabled = active.existing;
        canvas.dataset.implementation = !config.enabled ? "none" : active.current && active.existing ? "both" : config.algorithm;
        canvas.dataset.ssaoEnabled = String(config.enabled);
        canvas.dataset.mode = config.mode;
        divider.disabled = config.mode !== "split" || !config.enabled;
        clearHistory();
        updateDisplay();
    };
    const timingValues = document.getElementById("timingValues")!;
    const configureTiming = async () => {
        const epoch = ++timingEpoch;
        timing.disabled = true;
        try {
            const result = await setRenderTaskGpuTimingEnabled(engine, timing.checked && config.mode === "single");
            if (epoch !== timingEpoch) {
                return;
            }
            if (!result.supported) {
                timing.checked = false;
            }
            timing.disabled = !result.supported;
            timingValues.dataset.status = result.status;
        } catch (error) {
            timingValues.dataset.status = "error";
            timingValues.textContent = String(error);
            throw error;
        }
        totals.length = 0;
        lastTimingFrame = -1;
    };
    const changeTiming = () => {
        void configureTiming().catch((error) => {
            console.error(error);
            status.textContent = String(error);
        });
    };
    mode.addEventListener("change", () => {
        config.mode = mode.value === "split" ? "split" : "single";
        applySelection();
        changeTiming();
    });
    algorithm.addEventListener("change", () => {
        config.algorithm = algorithm.value === "current" ? "current" : "existing";
        applySelection();
    });
    ssaoEnabled.addEventListener("change", () => {
        config.enabled = ssaoEnabled.checked;
        applySelection();
    });
    timing.addEventListener("change", changeTiming);
    for (const element of [aoOnly, intensity, divider]) {
        element.addEventListener("input", updateDisplay);
    }
    radius.addEventListener("input", () => {
        current.radius = existing.radius = Number(radius.value);
        clearHistory();
        updateDisplay();
    });
    quality.addEventListener("change", () => {
        current.quality = quality.value as SsaoQuality;
        clearHistory();
    });
    for (const [id, field] of [
        ["slices", "sliceCount"],
        ["steps", "stepCount"],
    ] as const) {
        const control = input(id);
        control.value = String(existing[field]);
        control.required = true;
        control.addEventListener("change", () => {
            if (!control.reportValidity()) {
                return;
            }
            existing[field] = control.valueAsNumber;
            clearHistory();
        });
    }
    animate.addEventListener("change", () => setComparisonAnimation(actors, animate.checked));
    document.getElementById("reset")!.addEventListener("click", () => {
        objectTime = cameraTime = 0;
        sweep.checked = false;
        resetComparisonScene(actors);
        clearHistory();
    });
    const reload = () => {
        const url = new URL(location.href);
        for (const [key, value] of Object.entries({
            scene: sceneSelect.value,
            algorithm: config.algorithm,
            mode: config.mode,
            quality: quality.value,
            radius: radius.value,
            intensity: intensity.value,
            ao: aoOnly.checked ? "1" : "0",
            ssao: config.enabled ? "1" : "0",
            temporal: input("temporal").checked ? "1" : "0",
            normals: input("normals").checked ? "1" : "0",
            half: input("half").checked ? "1" : "0",
            reconstruction: select("reconstruction").value,
            pruning: config.pruning ? "1" : "0",
        })) {
            url.searchParams.set(key, value);
        }
        location.assign(url);
    };
    for (const element of [sceneSelect, select("reconstruction"), input("temporal"), input("normals"), input("half")]) {
        element.addEventListener("change", reload);
    }
    applySelection();
    onBeforeRender(scene, (deltaMs) => {
        if (animate.checked) {
            objectTime += deltaMs * 0.001;
            if (actors.sphere) {
                actors.sphere.position.x = 1.3 + Math.sin(objectTime) * 0.7;
            }
        }
        if (sweep.checked) {
            cameraTime += deltaMs * 0.001;
            camera.alpha = actors.preset.alpha + Math.sin(cameraTime * 0.8) * 0.15;
            camera.beta = actors.preset.beta + Math.sin(cameraTime * 0.6) * 0.03;
        }
        if (warmFrames < 64) {
            warmFrames++;
            canvas.dataset.warmFrames = String(warmFrames);
        }
        const snapshot = getRenderTaskGpuTimings(engine);
        if (warmFrames >= 64 && snapshot.status === "available" && snapshot.frameIndex > lastTimingFrame) {
            lastTimingFrame = snapshot.frameIndex;
            for (let i = 0; i < snapshot.tasks.length; i++) {
                const sample = snapshot.tasks[i]!;
                let row = totals[i];
                if (!row || row.name !== sample.name) {
                    row = { name: sample.name, sum: 0, count: 0 };
                    totals[i] = row;
                }
                row.sum += sample.durationMs;
                row.count++;
            }
            totals.length = snapshot.tasks.length;
        }
        refreshMs += deltaMs;
        if (refreshMs < 250) {
            return;
        }
        refreshMs = 0;
        const state = getRenderTaskGpuTimings(engine);
        if (config.mode === "split" && !config.enabled) {
            timingValues.textContent = "SSAO disabled.\nOnly scene color and the common compositor run.";
        } else if (config.mode === "split") {
            timingValues.textContent = "Split preview runs both algorithms.\nUse Single / A-B for isolated timings.";
        } else if (!timing.checked) {
            timingValues.textContent = state.supported ? "GPU timings disabled." : "GPU timestamp queries unsupported.";
        } else if (warmFrames < 64) {
            timingValues.textContent = `Settling ${config.enabled ? "history" : "timings"}: ${warmFrames}/64 frames`;
        } else if (state.status === "error") {
            timingValues.textContent = state.error ?? "GPU timing readback failed.";
        } else {
            let totalMs = 0;
            const lines = totals
                .filter((row) => row.count)
                .map((row) => {
                    const averageMs = row.sum / row.count;
                    totalMs += averageMs;
                    return `${row.name}: ${averageMs.toFixed(3)} ms`;
                });
            timingValues.textContent = lines.length ? `${lines.join("\n")}\ntotal: ${totalMs.toFixed(3)} ms` : "Waiting for GPU timestamps...";
        }
        for (const row of totals) {
            row.sum = 0;
            row.count = 0;
        }
        const workingMode = !config.half
            ? "Full"
            : !resolution.active
              ? "Full (small-viewport safeguard)"
              : config.reconstruction === "half"
                ? "Half pipeline"
                : "Half estimation/full reconstruction";
        status.textContent = config.enabled
            ? `${canvas.width}x${canvas.height} | XeGTAO ${workingMode}, ${quality.selectedOptions[0]!.text} | PR839 ${config.half ? "Half" : "Full"}, ${existing.sliceCount * existing.stepCount * 2} depth taps | history <=16 | common composition`
            : `${canvas.width}x${canvas.height} | SSAO disabled | ${aoOnly.checked ? "neutral AO (white)" : "unoccluded scene color"}`;
    });
    await registerScene(scene);
    await configureTiming();
    await startEngine(engine);
    canvas.dataset.ready = "true";
    canvas.dataset.scene = config.scene;
    window.addEventListener(
        "pagehide",
        () => {
            stopEngine(engine);
            for (const cancel of cancelResize) {
                cancel();
            }
            disposeScene(scene);
            disposeEffectWrapper(effect);
            for (const target of [color, currentRelay, existingRelay]) {
                disposeRenderTargetTexture(target);
            }
        },
        { once: true }
    );
}

void main().catch((error: unknown) => {
    console.error(error);
    document.getElementById("status")!.textContent = String(error);
    document.getElementById("renderCanvas")!.dataset.error = String(error);
});
