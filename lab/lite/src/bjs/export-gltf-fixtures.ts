import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/loadingScreen";
import type { Scene } from "@babylonjs/core/scene";

export function installExportReferenceRandom(): void {
    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
}

export async function createExportReferenceEngine(): Promise<{ engine: WebGPUEngine; canvas: HTMLCanvasElement; startedAt: number }> {
    const startedAt = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const antialias = new URLSearchParams(location.search).get("antialias") !== "0";
    const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true });
    await engine.initAsync();
    SceneLoader.ShowLoadingScreen = false;
    engine.displayLoadingUI = () => {};
    return { engine, canvas, startedAt };
}

export async function startExportReference(engine: WebGPUEngine, canvas: HTMLCanvasElement, scene: Scene, startedAt: number): Promise<void> {
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - startedAt);
    canvas.dataset.ready = "true";
}
