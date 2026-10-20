// Scene 331 — point sampling when available; scene 122's classic SOG + SH otherwise.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
// The non-pure mesh module also registers point splatting once the PR is released.
import "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/hornedlizard/hornedlizard.sog";
const ACCUMULATION_FRAMES = 300;

interface PointSplattingMesh {
    pointSplattingRenderMode?: boolean;
    pointSplattingRenderScale?: number | "auto";
    readonly pointSplattingProgress?: { renderedFrameCount: number; pixelCycleLength: number } | null;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", 4.6, 0.956, 3, new Vector3(0, -0.2, 0.2), scene);
    camera.minZ = 0.001;
    camera.maxZ = 1000;

    await ImportMeshAsync(SPLAT_URL, scene);
    const splat = scene.meshes[0]!;
    splat.rotation.x = Math.PI;
    const points = splat as typeof splat & PointSplattingMesh;
    const supportsPointSplatting = "pointSplattingRenderMode" in points;
    // TODO: Bump @babylonjs/core to the first release containing BabylonJS/Babylon.js#18962 and recapture the golden.
    if (supportsPointSplatting) {
        points.pointSplattingRenderScale = 1;
        points.pointSplattingRenderMode = true;
    }

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    const start = performance.now();
    while ((splat as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    if (supportsPointSplatting) {
        while ((points.pointSplattingProgress?.renderedFrameCount ?? 0) < ACCUMULATION_FRAMES) {
            await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
        }
    }

    camera.attachControl(canvas, true);
    canvas.dataset.renderMode = supportsPointSplatting ? "point" : "classic";
    canvas.dataset.renderedFrameCount = String(points.pointSplattingProgress?.renderedFrameCount ?? 0);
    canvas.dataset.pixelCycleLength = String(points.pointSplattingProgress?.pixelCycleLength ?? 0);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err: unknown) => {
    document.getElementById("renderCanvas")!.dataset.error = String(err);
    console.error(err);
});
