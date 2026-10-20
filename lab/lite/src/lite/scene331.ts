// Scene 331 — scene 122's SOG + SH, accumulated through Gaussian point sampling.
import { attachControl, createArcRotateCamera, createEngine, createSceneContext, enableGaussianPointSplatting, loadSOG, registerScene, startEngine } from "babylon-lite";

const SPLAT_URL = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/hornedlizard/hornedlizard.sog";
const ACCUMULATION_FRAMES = 300;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(4.6, 0.956, 3, { x: 0, y: -0.2, z: 0.2 });
    camera.nearPlane = 0.001;
    camera.farPlane = 1000;
    scene.camera = camera;

    const splat = await loadSOG(scene, SPLAT_URL);
    // 1 is the full-resolution divisor: every frame samples every output pixel.
    const points = enableGaussianPointSplatting(scene, splat, { renderScale: 1 });

    await registerScene(scene);
    await startEngine(engine);
    await splat.firstSortReady;
    while ((points.progress?.renderedFrameCount ?? 0) < ACCUMULATION_FRAMES) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    attachControl(camera, canvas, scene);
    canvas.dataset.renderMode = "point";
    canvas.dataset.renderedFrameCount = String(points.progress!.renderedFrameCount);
    canvas.dataset.pixelCycleLength = String(points.progress!.pixelCycleLength);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err: unknown) => {
    document.getElementById("renderCanvas")!.dataset.error = String(err);
    console.error(err);
});
