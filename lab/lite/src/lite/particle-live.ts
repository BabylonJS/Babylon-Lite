import {
    attachControl,
    buildNodeParticleSet,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    parseNodeParticleSource,
    registerNodeParticleSet,
    registerScene,
    startEngine,
} from "babylon-lite";

interface PreviewConfig {
    readonly source: unknown;
    readonly radius: number;
    readonly target: { x: number; y: number; z: number };
}

async function loadPreview(sceneId: number): Promise<PreviewConfig> {
    switch (sceneId) {
        case 262:
            return { source: (await import("../shared/scene262-npe.js")).SCENE262_NPE_JSON, radius: 4, target: { x: 0, y: 0.3, z: 0 } };
        case 263:
            return { source: (await import("../shared/scene263-npe.js")).SCENE263_NPE_JSON, radius: 14, target: { x: 0, y: 0, z: 0 } };
        case 264:
            return { source: (await import("../shared/scene264-npe.js")).SCENE264_NPE_JSON, radius: 12, target: { x: 0, y: 0.7, z: 0 } };
        case 268:
            return { source: (await import("../shared/scene268-npe.js")).SCENE268_NPE_JSON, radius: 4, target: { x: -1, y: 0, z: 0 } };
        default:
            throw new Error(`Unknown particle preview scene ${sceneId}`);
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const sceneId = Number(new URLSearchParams(window.location.search).get("scene") ?? "262");
    const preview = await loadPreview(sceneId);
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, preview.radius, preview.target);
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const graph = parseNodeParticleSource(preview.source);
    const set = await buildNodeParticleSet(engine, scene, graph, {
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    registerNodeParticleSet(scene, set);

    await registerScene(scene);
    await startEngine(engine);

    document.title = `Babylon Lite - Live NPE Particles ${sceneId}`;
    canvas.dataset.live = "true";
    canvas.dataset.scene = String(sceneId);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err instanceof Error ? err.message : err);
    }
});
