import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

interface WebGpuEngineDeviceAccess {
    _device: GPUDevice;
}

function seekAndFreeze(scene: Scene, seekTime: number): void {
    scene.animationGroups.forEach((g) => {
        const range = g.to - g.from;
        if (range > 0) {
            const seekFrame = g.from + (((Number.isNaN(seekTime) ? 2 : seekTime) * 60 - g.from) % range);
            g.goToFrame(seekFrame);
        }
    });
    scene.animatables.forEach((a) => a.pause());
}

async function buildRuntime(canvas: HTMLCanvasElement, recovered: boolean, seekTime: number): Promise<WebGPUEngine> {
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, doNotHandleContextLost: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    await SceneLoader.ImportMeshAsync("", "https://playground.babylonjs.com/scenes/Alien/", "Alien.gltf", scene);

    const _cam = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2, 2, new Vector3(0, 0, 0), scene);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    let frameCount = 0;
    let recoveredFrames = 0;
    let frozen = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        if (recovered && canvas.dataset.deviceRecovered === "true" && !frozen) {
            recoveredFrames++;
            canvas.dataset.postRecoveryFrames = String(recoveredFrames);
            if (recoveredFrames >= 10) {
                seekAndFreeze(scene, seekTime);
                frozen = true;
                canvas.dataset.animationFrozen = "true";
                canvas.dataset.ready = "true";
            }
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = "1";
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(resolve));
    canvas.dataset.loaded = "true";
    canvas.dataset.ready = "true";
    if (recovered) {
        canvas.dataset.deviceRecovered = "true";
    }
    return engine;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "2");

    const initialEngine = await buildRuntime(canvas, false, seekTimeParam);
    const initialDevice = (initialEngine as unknown as WebGpuEngineDeviceAccess)._device;
    void initialDevice.lost
        .then(async () => {
            canvas.dataset.deviceLost = "true";
            initialEngine.stopRenderLoop();
            await buildRuntime(canvas, true, seekTimeParam);
            canvas.dataset.initMs = String(performance.now() - __initStart);
        })
        .catch((error: unknown) => {
            canvas.dataset.recoveryFailed = error instanceof Error ? error.message : String(error);
            console.error(error);
        });
    initialDevice.destroy();
    canvas.dataset.initMs = String(performance.now() - __initStart);
})().catch(console.error);
