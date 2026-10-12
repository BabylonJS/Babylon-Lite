import {
    addTask,
    addTaskAtStart,
    addMeshToTask,
    addToScene,
    attachConfigurableFreeControl,
    createBloomPostProcessTask,
    createCsmDirectionalShadowGenerator,
    createComputeStorageTextureMipmapsTask,
    createDirectionalLight,
    createEngine,
    createFreeCamera,
    computeProceduralSkySunColor,
    enablePbrMaterialPluginVertexData,
    enableMirroredMeshes,
    isPbrMaterial,
    createRenderTarget,
    createSurfaceRenderTargetTexture,
    createRenderTask,
    createSceneContext,
    disposeScene,
    enableRenderTaskMeshRefresh,
    loadProceduralSkyEnvironment,
    markMaterialUboDirty,
    markMeshRenderableDirty,
    onRenderTargetTextureResize,
    createSmaaPostProcessTask,
    onBeforeRender,
    onSceneDispose,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    setShadowGeneratorEnabled,
    setLightDiffuseColor,
    setLightIntensity as updateLightIntensity,
    startEngine,
    updateProceduralSkyEnvironment,
    withSampledDepthTexture,
} from "babylon-lite";
import { OCEAN_SUN_DIRECTION, OCEAN_TEXTURE_SIZE } from "./constants.js";
import { createOceanBuoy } from "./buoy.js";
import { bindOceanControls, type OceanGeometryParameter, type OceanSkyParameter, type OceanWaveParameter } from "./controls.js";
import { createOceanTextureDebug } from "./debug.js";
import { createOceanClipmap } from "./geometry.js";
import { createOceanMaterials } from "./material.js";
import { createOceanSimulation, type OceanSimulation } from "./simulation.js";
import { disposeOceanDemoResources } from "./lifecycle.js";
import { createOceanSky } from "./sky.js";
import { DEFAULT_OCEAN_SPECTRUM, type OceanSpectrumSettings } from "./spectrum.js";
import { createOceanTimingPanel } from "./timing.js";
import { demoAssetUrl } from "../demo-asset-url.js";

function queryNumber(query: URLSearchParams, name: string, fallback: number): number {
    const value = Number(query.get(name) ?? fallback);
    return Number.isFinite(value) ? value : fallback;
}

function queryBoolean(query: URLSearchParams, name: string, fallback: boolean): boolean {
    const value = query.get(name);
    return value === null ? fallback : value === "true" || value === "1";
}

export async function runOceanDemo(canvas: HTMLCanvasElement): Promise<void> {
    const query = new URLSearchParams(location.search);
    const uiElements = [document.querySelector<HTMLElement>(".controls"), document.querySelector<HTMLElement>(".badge"), document.querySelector<HTMLElement>(".gpu-timing")].filter(
        (element): element is HTMLElement => element !== null
    );
    let uiHidden = query.has("hidegui");
    const setUiHidden = (hidden: boolean): void => {
        uiHidden = hidden;
        for (const element of uiElements) {
            element.hidden = hidden;
        }
    };
    setUiHidden(uiHidden);
    const onUiKeyDown = (event: KeyboardEvent): void => {
        if (
            event.code !== "F8" ||
            event.repeat ||
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLTextAreaElement
        ) {
            return;
        }
        event.preventDefault();
        setUiHidden(!uiHidden);
    };
    const resolution = queryNumber(query, "resolution", OCEAN_TEXTURE_SIZE);
    const lengthScale = queryNumber(query, "lengthScale", 15);
    const vertexDensity = queryNumber(query, "vertexDensity", 30);
    const clipLevels = queryNumber(query, "clipLevels", 8);
    const skirtSize = queryNumber(query, "skirtSize", 10);
    const wireframe = queryBoolean(query, "wireframe", false);
    const noMaterialLod = queryBoolean(query, "noMaterialLod", true);
    let reloadTimer = 0;
    const reloadWith = (name: string, value: string | number | boolean): void => {
        query.set(name, String(value));
        clearTimeout(reloadTimer);
        reloadTimer = window.setTimeout(() => {
            location.search = query.toString();
        }, 250);
    };
    const engine = await createEngine(canvas, { maxDevicePixelRatio: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    window.addEventListener("keydown", onUiKeyDown);
    onSceneDispose(scene, () => {
        window.removeEventListener("keydown", onUiKeyDown);
        clearTimeout(reloadTimer);
    });
    let ownedSimulation: OceanSimulation | undefined;
    let completeCleanup!: () => void;
    let failCleanup!: (error: unknown) => void;
    const cleanup = new Promise<void>((resolve, reject) => {
        completeCleanup = resolve;
        failCleanup = reject;
    });
    onSceneDispose(scene, () => {
        // Scene callbacks precede mesh teardown. Wait for that synchronous drain and
        // for private render-task retirements before releasing sampled compute outputs.
        void Promise.resolve()
            .then(() => disposeOceanDemoResources(engine, ownedSimulation))
            .then(completeCleanup, failCleanup);
    });
    void cleanup.catch((error: unknown) => console.error("Ocean cleanup failed.", error));
    try {
        scene.clearColor = { r: 0.24, g: 0.43, b: 0.62, a: 1 };

        const camera = createFreeCamera(
            { x: -33.91187023336096, y: 4.727123075533213, z: -8.578004717405992 },
            { x: -32.91802588437002, y: 4.835790486320023, z: -8.599564026570702 }
        );
        const getOceanCameraParameters = () => ({
            position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            rotation: { x: camera._pitch, y: camera._yaw, z: 0 },
            target: { x: camera.target.x, y: camera.target.y, z: camera.target.z },
        });
        const oceanGlobal = globalThis as typeof globalThis & { getOceanCameraParameters?: () => unknown };
        oceanGlobal.getOceanCameraParameters = getOceanCameraParameters;
        onSceneDispose(scene, () => {
            if (oceanGlobal.getOceanCameraParameters === getOceanCameraParameters) {
                delete oceanGlobal.getOceanCameraParameters;
            }
        });
        camera.nearPlane = 1;
        camera.farPlane = 100_000;
        camera.speed = 2;
        scene.camera = camera;
        onSceneDispose(
            scene,
            attachConfigurableFreeControl(camera, canvas, scene, {
                upKeys: ["Space", "PageUp"],
                downKeys: ["KeyC", "PageDown"],
                fastKeys: ["ShiftLeft", "ShiftRight"],
                fastMultiplier: 5,
            })
        );

        const sun = createDirectionalLight([-OCEAN_SUN_DIRECTION[0], -OCEAN_SUN_DIRECTION[1], -OCEAN_SUN_DIRECTION[2]], 1.15);
        const shadows = createCsmDirectionalShadowGenerator(engine, sun, {
            mapSize: 2048,
            numCascades: 4,
            lambda: 0.75,
            bias: 0.005,
            shadowMaxZ: 500,
        });
        sun.shadowGenerator = shadows;
        addToScene(scene, sun);
        scene.imageProcessing.exposure = 1;
        scene.imageProcessing.contrast = 1;
        scene.imageProcessing.toneMappingEnabled = false;

        const buoy = await createOceanBuoy(engine, scene);
        setShadowTaskCasterMeshes(shadows, buoy.meshes);

        const opaqueDepth = createSurfaceRenderTargetTexture(
            engine,
            {
                lbl: "ocean-opaque-depth",
                format: engine.format,
                dFormat: "depth32float",
                samples: 1,
                size: engine,
            },
            withSampledDepthTexture
        );
        if (!opaqueDepth.depthTexture) {
            throw new Error("Ocean requires a sampled opaque depth texture.");
        }
        const depthTask = createRenderTask({ name: "ocean-depth-prepass", rt: opaqueDepth.rt, clr: true, clrColor: scene.clearColor, cs: true }, engine, scene);
        for (const mesh of buoy.meshes) {
            addMeshToTask(depthTask, mesh);
        }

        const simulation = await createOceanSimulation(engine, resolution);
        ownedSimulation = simulation;
        const derivativeMipmaps = createComputeStorageTextureMipmapsTask(
            "ocean-derivative-mipmaps",
            simulation.resources.cascades.map((cascade) => cascade.derivatives)
        );
        const turbulenceAMipmaps = createComputeStorageTextureMipmapsTask(
            "ocean-turbulence-a-mipmaps",
            simulation.resources.cascades.map((cascade) => cascade.turbulenceA)
        );
        const turbulenceBMipmaps = createComputeStorageTextureMipmapsTask(
            "ocean-turbulence-b-mipmaps",
            simulation.resources.cascades.map((cascade) => cascade.turbulenceB)
        );
        const materials = await createOceanMaterials(engine, simulation.resources, opaqueDepth.depthTexture, [camera.nearPlane, camera.farPlane]);
        const ocean = createOceanClipmap(engine, scene, materials, { lengthScale, vertexDensity, clipLevels, skirtSize, wireframe, noMaterialLod });
        onRenderTargetTextureResize(opaqueDepth, () => {
            for (const mesh of ocean.meshes) {
                markMeshRenderableDirty(mesh);
            }
        });

        const sceneTarget = createRenderTarget({
            lbl: "ocean-scene",
            format: engine.format,
            dFormat: "depth24plus-stencil8",
            samples: 1,
            size: engine,
        });
        const sky = createOceanSky(engine, scene, sceneTarget);
        const sceneTask = createRenderTask({ name: "ocean-scene", rt: sceneTarget, clr: false, depthClear: true, sharedRt: true, autoMirror: false }, engine, scene);
        enableRenderTaskMeshRefresh(sceneTask);
        for (const mesh of [...ocean.meshes, ...buoy.meshes]) {
            addMeshToTask(sceneTask, mesh);
        }
        const textureDebug = createOceanTextureDebug(engine, scene, sceneTarget, simulation.resources);
        const timing = createOceanTimingPanel(engine);
        const bloom = createBloomPostProcessTask(
            {
                name: "ocean-bloom",
                sourceTexture: sceneTarget,
                targetTexture: null,
                threshold: 0.78,
                exposure: 1,
                weight: 0,
                kernel: 48,
                bloomScale: 0.5,
            },
            engine,
            scene
        );
        const antialiasing = createSmaaPostProcessTask(
            {
                name: "ocean-antialiasing",
                sourceTexture: bloom.outputTexture,
                targetTexture: engine.scRT,
                threshold: 0.05,
                maxSearchSteps: 16,
            },
            engine,
            scene
        );

        addTaskAtStart(scene, turbulenceBMipmaps);
        addTaskAtStart(scene, turbulenceAMipmaps);
        addTaskAtStart(scene, derivativeMipmaps);
        addTaskAtStart(scene, simulation.mergeTask);
        addTaskAtStart(scene, simulation.fftTask);
        addTaskAtStart(scene, simulation.spectrumTask);
        addTaskAtStart(scene, simulation.initializationTask);
        addTask(scene, depthTask);
        addTask(scene, sky.task);
        addTask(scene, sceneTask);
        addTask(scene, textureDebug.task);
        addTask(scene, bloom);
        addTask(scene, antialiasing);

        const seekValue = query.get("seekTime") ?? query.get("seektime");
        const seekTime = Number(seekValue ?? 0);
        if (!Number.isFinite(seekTime) || seekTime < 0) {
            throw new Error(`Ocean seekTime must be finite and non-negative, received "${seekValue}".`);
        }
        const animateValue = query.get("animate");
        const animateFromQuery = animateValue === null ? seekValue === null : animateValue !== "false" && animateValue !== "0";
        let paused = !animateFromQuery;
        let elapsed = seekTime;
        let bloomDirty = false;
        let buoyReadPending = false;
        let buoyReadFrame = 0;
        let buoyReadEnabled = false;
        let frozenSimulationFrames = paused ? 1 : 0;
        let pendingWarmupMipFrame = false;
        let skyEnvironmentDirty = false;
        const skySettings: Record<OceanSkyParameter, number> = {
            inclination: 0,
            azimuth: 0.307,
            luminance: 1,
            turbidity: 10,
            rayleigh: 2,
            mieCoefficient: 0.005,
            mieDirectionalG: 0.8,
        };
        const spectrum: OceanSpectrumSettings = {
            ...DEFAULT_OCEAN_SPECTRUM,
            local: { ...DEFAULT_OCEAN_SPECTRUM.local },
            swell: { ...DEFAULT_OCEAN_SPECTRUM.swell },
        };
        const refreshSpectrum = (): void => {
            if (paused) {
                frozenSimulationFrames = 1;
            }
            void simulation.setSpectrum(spectrum).catch((error: unknown) => {
                canvas.dataset.error = error instanceof Error ? error.message : String(error);
            });
        };
        const getSunDirection = (): [number, number, number] => {
            const theta = Math.PI * (skySettings.inclination - 0.5);
            const phi = 2 * Math.PI * (skySettings.azimuth - 0.5);
            const cosTheta = Math.cos(theta);
            return [Math.cos(phi) * cosTheta, Math.sin(-theta), Math.sin(phi) * cosTheta];
        };
        const skyEnvironmentOptions = () => ({
            sunDirection: getSunDirection(),
            luminance: skySettings.luminance,
            turbidity: skySettings.turbidity,
            rayleigh: skySettings.rayleigh,
            mieCoefficient: skySettings.mieCoefficient,
            mieDirectionalG: skySettings.mieDirectionalG,
        });
        const updateSun = (): void => {
            const direction = getSunDirection();
            const environmentOptions = skyEnvironmentOptions();
            materials.setSunDirection(direction);
            sky.setSunDirection(direction);
            sun.direction.set(-direction[0], -direction[1], -direction[2]);
            setLightDiffuseColor(sun, computeProceduralSkySunColor(environmentOptions));
            skyEnvironmentDirty = true;
        };
        bindOceanControls(
            {
                setPaused(value): void {
                    paused = value;
                    buoy.setPaused(paused);
                    buoyReadEnabled = !paused;
                    if (!paused) {
                        frozenSimulationFrames = 0;
                    }
                    canvas.dataset.animationFrozen = String(paused);
                },
                setResolution(value): void {
                    if (value !== resolution) {
                        reloadWith("resolution", value);
                    }
                },
                setEnvironmentIntensity(value): void {
                    materials.setEnvironmentIntensity(value);
                    for (const mesh of buoy.meshes) {
                        if (isPbrMaterial(mesh.material)) {
                            mesh.material.environmentIntensity = value;
                            markMaterialUboDirty(mesh.material);
                        }
                    }
                },
                setLightIntensity(value): void {
                    updateLightIntensity(sun, value);
                },
                setShadowsEnabled(value): void {
                    setShadowGeneratorEnabled(shadows, value);
                },
                setDebugEnabled(value): void {
                    textureDebug.setVisible(value);
                },
                setBloomEnabled(value): void {
                    const weight = value ? 0.32 : 0;
                    if (bloom.weight !== weight) {
                        bloom.weight = weight;
                        bloomDirty = true;
                    }
                },
                setSkyParameter(name, value): void {
                    skySettings[name] = value;
                    sky.setParameter(name, value);
                    updateSun();
                },
                setWaveParameter(name: OceanWaveParameter, value: number): void {
                    if (name === "lambda") {
                        spectrum.lambda = value;
                        simulation.setChoppiness(value);
                        if (paused) {
                            frozenSimulationFrames = 1;
                        }
                        return;
                    }
                    if (name === "gravity" || name === "depth") {
                        spectrum[name] = value;
                    } else {
                        const [family, property] = name.split(".") as ["local" | "swell", keyof typeof spectrum.local];
                        spectrum[family][property] = value;
                    }
                    refreshSpectrum();
                },
                setGeometryParameter(name: OceanGeometryParameter, value: number): void {
                    ocean.setGeometryParameter(name, value);
                    ocean.update(camera);
                },
                setWireframe(value): void {
                    ocean.setWireframe(value);
                },
                setNoMaterialLod(value): void {
                    ocean.setNoMaterialLod(value);
                    ocean.update(camera);
                },
                setShaderNumber(name, value): void {
                    materials.setNumber(name, value);
                },
                setShaderColor(name, value): void {
                    materials.setColor(name, value);
                },
                setBuoyancyEnabled(value): void {
                    buoy.setEnabled(value);
                },
                setBuoyancyAttenuation(value): void {
                    buoy.setAttenuation(value);
                },
                setBuoyancySteps(value): void {
                    buoy.setSteps(value);
                },
            },
            { paused, resolution, lengthScale, vertexDensity, clipLevels, skirtSize, wireframe, noMaterialLod }
        );
        const skyEnvironment = await loadProceduralSkyEnvironment(scene, {
            ...skyEnvironmentOptions(),
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        });
        skyEnvironmentDirty = false;

        onBeforeRender(scene, (deltaMs) => {
            timing.update(deltaMs);
            if (camera.position.y < 1.5) {
                camera.position.y = 1.5;
            }
            if (bloomDirty) {
                bloom.updateUniforms();
                bloomDirty = false;
            }
            if (skyEnvironmentDirty) {
                skyEnvironmentDirty = false;
                void updateProceduralSkyEnvironment(skyEnvironment, skyEnvironmentOptions()).catch((error: unknown) => {
                    canvas.dataset.error = error instanceof Error ? error.message : String(error);
                });
            }
            const deltaSeconds = Math.min(deltaMs, 100) / 1000;
            const runWarmupMipFrame = pendingWarmupMipFrame;
            const runFrozenFrame = paused && frozenSimulationFrames > 0;
            const runSimulation = !paused || runFrozenFrame;
            simulation.setExecutionEnabled(runSimulation);
            derivativeMipmaps.executionEnabled = runSimulation || runWarmupMipFrame;
            if (runFrozenFrame) {
                frozenSimulationFrames--;
            }
            if (!paused) {
                elapsed += deltaSeconds;
            }
            simulation.setBuoyancyFrame(buoy.probePositions());
            simulation.update(elapsed, !paused && runSimulation ? deltaSeconds : 0);
            turbulenceAMipmaps.executionEnabled = (runSimulation || runWarmupMipFrame) && simulation.turbulenceIndex === 0;
            turbulenceBMipmaps.executionEnabled = (runSimulation || runWarmupMipFrame) && simulation.turbulenceIndex === 1;
            pendingWarmupMipFrame = false;
            if (!paused) {
                buoy.update(elapsed);
            }
            materials.update(simulation.turbulenceIndex, elapsed);
            ocean.update(camera);
            sky.update(camera, canvas.width, canvas.height);
            if (buoyReadEnabled && !paused && !buoyReadPending && buoyReadFrame++ % 6 === 0) {
                buoyReadPending = true;
                void simulation.readBuoyancy().then(
                    (samples) => {
                        buoy.setSamples(samples);
                        buoyReadPending = false;
                    },
                    (error: unknown) => {
                        buoyReadPending = false;
                        canvas.dataset.error = error instanceof Error ? error.message : String(error);
                    }
                );
            }
        });

        await enableMirroredMeshes(scene);
        enablePbrMaterialPluginVertexData();
        await registerSceneWithShadowSupport(scene);
        if (seekValue !== null || paused) {
            simulation.setBuoyancyFrame(buoy.probePositions());
            const warmupFrames = await simulation.warmup(seekTime);
            frozenSimulationFrames = 0;
            pendingWarmupMipFrame = true;
            if (seekValue !== null) {
                canvas.dataset.seekWarmupFrames = String(warmupFrames);
                canvas.dataset.seekWarmupMode = "compute-only";
            }
            buoy.seek(elapsed, engine);
            buoy.setPaused(paused);
            for (let iteration = 0; iteration < buoy.seekIterations(); iteration++) {
                buoy.setSamples(await simulation.sampleBuoyancy(buoy.probePositions()));
                buoy.updateSeek(elapsed);
            }
        }
        if (paused) {
            simulation.setExecutionEnabled(false);
            derivativeMipmaps.executionEnabled = false;
            turbulenceAMipmaps.executionEnabled = false;
            turbulenceBMipmaps.executionEnabled = false;
        } else {
            buoyReadEnabled = true;
        }
        await timing.enable();
        await startEngine(engine);
        await simulation.initialization.completion;
        document.getElementById("loading")?.remove();
        canvas.dataset.oceanStage = "complete";
        canvas.dataset.animationFrozen = String(paused);
        canvas.dataset.ready = "true";
    } catch (error) {
        disposeScene(scene);
        try {
            await cleanup;
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Ocean initialization and cleanup failed.", { cause: error });
        }
        throw error;
    }
}
