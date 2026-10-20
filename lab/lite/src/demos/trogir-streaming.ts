import {
    attachGaussianSplatStream,
    createEngine,
    createSceneContext,
    disableGaussianPointSplatting,
    disposeEngine,
    disposeGaussianSplatStream,
    disposeScene,
    enableGaussianPointSplatting,
    loadGaussianSplatStream,
    loadSplatVoxelCollision,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, GaussianPointSplatting, GaussianSplatStream, SceneContext } from "babylon-lite";
import { attachTrogirCameraControls, createTrogirCamera } from "./trogir-camera";
import { formatTrogirCameraPose } from "./trogir-camera-pose";
import { placeTrogirStream } from "./trogir-streaming-placement";
import { acquireTrogirStartupResource, finishTrogirStartup, observeTrogirStartupReadiness } from "./trogir-streaming-lifecycle";
import { resolveTrogirAssets } from "./trogir-assets";
import { attachTrogirCollision } from "./trogir-collision";
import { resolveTrogirQuality } from "./trogir-quality";

const LOCAL_SETUP = 'GS_STREAM_ASSET_ROOT="<dataset-directory>" pnpm --dir lab dev';
const MB = 1024 * 1024;

function formatCount(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

function output(id: string): HTMLOutputElement {
    return document.getElementById(id) as HTMLOutputElement;
}

function installHud(scene: SceneContext, stream: GaussianSplatStream, canvas: HTMLCanvasElement): () => void {
    const phase = output("phase");
    const firstFrame = output("firstFrame");
    const selectedSplats = output("selectedSplats");
    const leaves = output("leaves");
    const gpuBytes = output("gpuBytes");
    const requests = output("requests");
    const fps = output("fps");
    let frameTime = 0;
    let frameCount = 0;
    const screenError = document.getElementById("screenError") as HTMLInputElement;
    const screenErrorValue = output("screenErrorValue");
    const splatBudget = document.getElementById("splatBudget") as HTMLInputElement;
    splatBudget.max = String(stream.maxSplats);
    splatBudget.value = String(stream.maxSplats);
    const splatBudgetValue = output("splatBudgetValue");
    const cameraPose = document.getElementById("cameraPose") as HTMLDetailsElement;
    const cameraX = output("cameraX");
    const cameraY = output("cameraY");
    const cameraZ = output("cameraZ");
    const cameraYaw = output("cameraYaw");
    const cameraPitch = output("cameraPitch");
    const cameraRoll = output("cameraRoll");
    const cameraPoseStatus = document.getElementById("cameraPoseStatus") as HTMLElement;
    const cameraOutputs = [cameraX, cameraY, cameraZ, cameraYaw, cameraPitch, cameraRoll];
    const pointSampling = document.getElementById("pointSampling") as HTMLInputElement;
    const pointSamplingOptions = document.getElementById("pointSamplingOptions") as HTMLElement;
    const pointScale = document.getElementById("pointScale") as HTMLInputElement;
    const pointScaleValue = output("pointScaleValue");
    const renderScale = document.getElementById("renderScale") as HTMLSelectElement;
    const occlusionCulling = document.getElementById("occlusionCulling") as HTMLInputElement;
    const temporalReprojection = document.getElementById("temporalReprojection") as HTMLInputElement;
    const maxAccumFrames = document.getElementById("maxAccumFrames") as HTMLInputElement;
    const maxAccumFramesValue = output("maxAccumFramesValue");
    const accumulatedFrames = output("accumulatedFrames");
    const pixelCycleLength = output("pixelCycleLength");
    let pointSplatting: GaussianPointSplatting | null = null;
    let disposed = false;

    const applyPointOptions = (): void => {
        const options = {
            pointScale: Number(pointScale.value),
            renderScale: renderScale.value === "auto" ? ("auto" as const) : Number(renderScale.value),
            occlusionCulling: occlusionCulling.checked,
            temporalReprojection: temporalReprojection.checked,
            maxAccumFrames: Number(maxAccumFrames.value),
        };
        pointScaleValue.value = `${options.pointScale.toFixed(1)}×`;
        maxAccumFramesValue.value = String(options.maxAccumFrames);
        if (pointSplatting) {
            Object.assign(pointSplatting, options);
        }
    };
    const togglePointSampling = (): void => {
        if (pointSampling.checked && !pointSplatting) {
            pointSplatting = enableGaussianPointSplatting(scene, stream, { colorRenderMode: false });
        }
        applyPointOptions();
        if (pointSplatting) {
            pointSplatting.colorRenderMode = pointSampling.checked;
        }
        pointSamplingOptions.hidden = !pointSampling.checked;
    };
    const query = new URL(location.href).searchParams;
    pointSampling.checked = query.get("points") === "1";
    temporalReprojection.checked = query.get("reproject") === "1";
    pointSampling.addEventListener("change", togglePointSampling);
    pointScale.addEventListener("input", applyPointOptions);
    renderScale.addEventListener("change", applyPointOptions);
    occlusionCulling.addEventListener("change", applyPointOptions);
    temporalReprojection.addEventListener("change", applyPointOptions);
    maxAccumFrames.addEventListener("input", applyPointOptions);
    togglePointSampling();

    const applyControls = (): void => {
        stream.screenError = Number(screenError.value);
        stream.maxSplats = Number(splatBudget.value);
        screenErrorValue.value = `${stream.screenError.toFixed(2)} px`;
        splatBudgetValue.value = `${Math.round(stream.maxSplats / 1000)}k`;
    };
    screenError.addEventListener("input", applyControls);
    splatBudget.addEventListener("input", applyControls);
    applyControls();

    const updateCameraPose = (): void => {
        if (disposed || !cameraPose.open || !scene.camera) {
            return;
        }
        let pose;
        try {
            pose = formatTrogirCameraPose(scene.camera.worldMatrix);
        } catch (reason) {
            if (!(reason instanceof RangeError)) {
                throw reason;
            }
            for (const field of cameraOutputs) {
                field.value = "Unavailable";
            }
            cameraPoseStatus.textContent = reason.message;
            cameraPoseStatus.hidden = false;
            return;
        }
        cameraX.value = pose.x;
        cameraY.value = pose.y;
        cameraZ.value = pose.z;
        cameraYaw.value = `${pose.yaw}°`;
        cameraPitch.value = `${pose.pitch}°`;
        cameraRoll.value = `${pose.roll}°`;
        cameraPoseStatus.hidden = true;
    };
    cameraPose.addEventListener("toggle", updateCameraPose);

    onBeforeRender(scene, (deltaMs) => {
        if (disposed) {
            return;
        }
        if (deltaMs > 0) {
            frameTime += deltaMs;
            frameCount++;
            if (frameTime >= 500) {
                const averageMs = frameTime / frameCount;
                fps.value = `${(1000 / averageMs).toFixed(1)} FPS · ${averageMs.toFixed(1)} ms`;
                frameTime = frameCount = 0;
            }
        }
        if (pointSampling.checked) {
            const progress = pointSplatting?.progress;
            accumulatedFrames.value = progress && pointSplatting ? `${formatCount(progress.accumulatedSamples)} / ${formatCount(pointSplatting.maxAccumFrames)}` : "—";
            pixelCycleLength.value = progress ? `${progress.pixelCycleLength} frames` : "—";
        }
        const stats = stream.stats;
        phase.value = stats.phase;
        firstFrame.value = stats.firstFrameMs === null ? "—" : `${Math.round(stats.firstFrameMs)} ms`;
        selectedSplats.value = formatCount(stats.selectedSplats);
        leaves.value = `${formatCount(stats.visibleLeaves)} / ${formatCount(stats.coveredLeaves)}`;
        gpuBytes.value = `${(stats.residentGpuBytes / MB).toFixed(1)} / ${(stats.allocatedGpuBytes / MB).toFixed(1)} MB`;
        requests.value = `${stats.residentFiles} / ${stats.pendingRequests}`;
        canvas.dataset.streamPhase = stats.phase;
        canvas.dataset.selectedSplats = String(stats.selectedSplats);
        canvas.dataset.residentFiles = String(stats.residentFiles);
        if (stats.error) {
            canvas.dataset.streamError = stats.error.message;
        }
        updateCameraPose();
    });

    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        pointSampling.removeEventListener("change", togglePointSampling);
        pointScale.removeEventListener("input", applyPointOptions);
        renderScale.removeEventListener("change", applyPointOptions);
        occlusionCulling.removeEventListener("change", applyPointOptions);
        maxAccumFrames.removeEventListener("input", applyPointOptions);
        if (pointSplatting) {
            disableGaussianPointSplatting(scene, pointSplatting);
        }
        screenError.removeEventListener("input", applyControls);
        splatBudget.removeEventListener("input", applyControls);
        cameraPose.removeEventListener("toggle", updateCameraPose);
    };
}

function showError(reason: unknown, canvas: HTMLCanvasElement): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    canvas.dataset.error = message;
    const overlay = document.getElementById("loading");
    const title = document.getElementById("loadingTitle");
    const detail = document.getElementById("loadingDetail");
    overlay?.classList.add("error");
    if (title) {
        title.textContent = "Unable to start Trogir streaming";
    }
    if (detail) {
        detail.textContent = `${message}\n\nThe public Trogir stream could not be loaded. To use a local dataset, run:\n${LOCAL_SETUP}\n\nThen open this demo with ?assetRoot=/local-gs/trogir/. You can also provide any hosted dataset root with ?assetRoot=https://host/path/to/dataset/.`;
    }
    const retry = document.getElementById("lowerQuality") as HTMLAnchorElement;
    const url = new URL(location.href);
    if (url.searchParams.get("quality") === "high") {
        url.searchParams.set("quality", "low");
        retry.href = url.href;
        retry.hidden = false;
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const quality = resolveTrogirQuality(location.href);
    const qualitySelect = document.getElementById("quality") as HTMLSelectElement;
    qualitySelect.value = quality.name;
    const changeQuality = (): void => {
        const url = new URL(location.href);
        url.searchParams.set("quality", qualitySelect.value);
        location.assign(url.href);
    };
    qualitySelect.addEventListener("change", changeQuality);
    // Keep this available after startup failure so a lower tier can be selected.
    window.addEventListener("pagehide", () => qualitySelect.removeEventListener("change", changeQuality), { once: true });
    let engine: EngineContext | null = null;
    let scene: SceneContext | null = null;
    let stream: GaussianSplatStream | null = null;
    const abort = new AbortController();
    let disposeCollision: (() => void) | null = null;
    let disposeCameraControls: (() => void) | null = null;
    let disposeHud: (() => void) | null = null;
    let disposed = false;
    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        abort.abort();
        disposeCollision?.();
        disposeHud?.();
        disposeCameraControls?.();
        if (scene && stream) {
            disposeGaussianSplatStream(scene, stream);
        }
        if (scene) {
            disposeScene(scene);
        }
        if (engine) {
            disposeEngine(engine);
        }
        canvas.dataset.streamPhase = "disposed";
        canvas.dataset.disposed = "true";
    };
    window.addEventListener("pagehide", dispose, { once: true });

    try {
        const assets = resolveTrogirAssets(location.href);
        const collisionReady = loadSplatVoxelCollision(assets.collisionUrl, abort.signal).then(
            (collision) => ({ collision, error: null }),
            (reason: unknown) => ({ collision: null, error: reason instanceof Error ? reason.message : String(reason) })
        );
        const createdEngine = await acquireTrogirStartupResource(
            createEngine(canvas, {
                requiredLimits: quality.requiredLimits,
            }),
            () => disposed,
            disposeEngine
        );
        if (!createdEngine) {
            return;
        }
        engine = createdEngine;
        scene = createSceneContext(engine);
        const loadedStream = await acquireTrogirStartupResource(
            loadGaussianSplatStream(engine, assets.metadataUrl, {
                ...quality.streamOptions,
                screenError: 2,
                signal: abort.signal,
            }).then((candidate) => {
                observeTrogirStartupReadiness(candidate.firstFrameReady);
                return candidate;
            }),
            () => disposed,
            (lateStream) => disposeGaussianSplatStream(scene!, lateStream)
        );
        if (!loadedStream) {
            return;
        }
        stream = loadedStream;
        placeTrogirStream(stream);
        const camera = createTrogirCamera();
        scene.camera = camera;
        void collisionReady
            .then(({ collision, error }) => {
                if (disposed) {
                    return;
                }
                const status = document.getElementById("navigationStatus")!;
                if (!collision) {
                    status.textContent = `Navigation unavailable: ${error}`;
                    canvas.dataset.collisionReady = "false";
                    return;
                }
                disposeCameraControls = attachTrogirCameraControls(camera, canvas, scene!);
                disposeCollision = attachTrogirCollision(camera, scene!, collision);
                status.textContent = "Collisions enabled";
                canvas.dataset.collisionReady = "true";
            })
            .catch((reason: unknown) => {
                if (!disposed) {
                    dispose();
                    showError(reason, canvas);
                }
            });

        attachGaussianSplatStream(scene, stream);
        disposeHud = installHud(scene, stream, canvas);
        await finishTrogirStartup({
            register: () => registerScene(scene!),
            start: () => startEngine(engine!),
            firstFrame: stream.firstFrameReady,
            isDisposed: () => disposed,
            dispose,
            ready: () => {
                const coarseReadyAt = performance.now();
                canvas.dataset.coarseSubmitted = "true";
                canvas.dataset.coarseSubmittedAt = String(coarseReadyAt);
                canvas.dataset.coarseReady = "true";
                canvas.dataset.coarseReadyAt = String(coarseReadyAt);
                canvas.dataset.ready = "true";
                const overlay = document.getElementById("loading");
                overlay?.classList.add("hidden");
                window.setTimeout(() => overlay?.remove(), 450);
            },
            fail: (reason) => showError(reason, canvas),
        });
    } catch (reason) {
        if (disposed) {
            return;
        }
        dispose();
        showError(reason, canvas);
    }
}

void main();
