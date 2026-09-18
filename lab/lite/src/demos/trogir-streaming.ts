import {
    attachGaussianSplatStream,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    disposeEngine,
    disposeGaussianSplatStream,
    disposeScene,
    loadGaussianSplatStream,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, GaussianSplatStream, SceneContext } from "babylon-lite";
import { attachTrogirCameraMode } from "./trogir-camera-mode";
import { formatTrogirCameraPose } from "./trogir-camera-pose";
import { placeTrogirStream } from "./trogir-streaming-placement";

const DEFAULT_METADATA_URL = "https://assets.babylonjs.com/splats/Trogir/lod-meta.json";
const LOCAL_SETUP = 'GS_STREAM_ASSET_ROOT="<dataset-directory>" pnpm --dir lab dev';
const MB = 1024 * 1024;
const MAX_FOREGROUND_SPLATS = 4_000_000;
const STREAM_CAPACITY = MAX_FOREGROUND_SPLATS + 10_000;

function metadataUrl(): string {
    const configured = new URLSearchParams(location.search).get("assetRoot");
    if (!configured) {
        return DEFAULT_METADATA_URL;
    }
    const root = new URL(configured, location.href);
    if (root.protocol !== "http:" && root.protocol !== "https:") {
        throw new Error("assetRoot must resolve to an HTTP(S) URL.");
    }
    if (root.pathname.endsWith("/lod-meta.json")) {
        return root.href;
    }
    if (!root.pathname.endsWith("/")) {
        root.pathname += "/";
    }
    return new URL("lod-meta.json", root).href;
}

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
    const screenError = document.getElementById("screenError") as HTMLInputElement;
    const screenErrorValue = output("screenErrorValue");
    const splatBudget = document.getElementById("splatBudget") as HTMLInputElement;
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
    let disposed = false;

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

    onBeforeRender(scene, () => {
        if (disposed) {
            return;
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
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    let engine: EngineContext | null = null;
    let scene: SceneContext | null = null;
    let stream: GaussianSplatStream | null = null;
    let disposeCameraMode: (() => void) | null = null;
    let disposeHud: (() => void) | null = null;
    let disposed = false;
    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        disposeHud?.();
        disposeCameraMode?.();
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
        engine = await createEngine(canvas, {
            requiredLimits: {
                maxBufferSize: STREAM_CAPACITY * 64,
                maxStorageBufferBindingSize: STREAM_CAPACITY * 64,
            },
        });
        scene = createSceneContext(engine);
        stream = await loadGaussianSplatStream(engine, metadataUrl(), {
            maxSplats: 750_000,
            maxCapacitySplats: STREAM_CAPACITY,
            maxGpuBytes: 1024 * MB,
            maxCpuBytes: 96 * MB,
            screenError: 2,
        });
        const camera = createArcRotateCamera(-Math.PI / 2, 1.16, 260, placeTrogirStream(stream));
        camera.nearPlane = 0.1;
        camera.farPlane = 1500;
        scene.camera = camera;
        disposeCameraMode = attachTrogirCameraMode(
            scene,
            canvas,
            document.getElementById("cameraMode") as HTMLButtonElement,
            document.getElementById("cameraHint") as HTMLElement,
            camera
        );

        attachGaussianSplatStream(scene, stream);
        disposeHud = installHud(scene, stream, canvas);
        await registerScene(scene);
        await startEngine(engine);
        await stream.firstFrameReady;

        const coarseReadyAt = performance.now();
        canvas.dataset.coarseSubmitted = "true";
        canvas.dataset.coarseSubmittedAt = String(coarseReadyAt);
        canvas.dataset.coarseReady = "true";
        canvas.dataset.coarseReadyAt = String(coarseReadyAt);
        canvas.dataset.ready = "true";
        const overlay = document.getElementById("loading");
        overlay?.classList.add("hidden");
        window.setTimeout(() => overlay?.remove(), 450);
    } catch (reason) {
        showError(reason, canvas);
    }
}

void main();
