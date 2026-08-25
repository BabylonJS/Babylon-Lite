// Scene 304 — Khronos Calculator KHR_interactivity end-to-end.
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    enableFlowGraphPointerPicking,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const asset = await loadGltf(engine, "/models/Calculator.glb");
    addToScene(scene, asset);
    scene.clearColor = { r: 0.08, g: 0.09, b: 0.12, a: 1 };
    await loadEnvironment(scene, "/textures/environment.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const camera = createArcRotateCamera(1.6115, 0.8736, 2.2443, { x: 0, y: 0.15, z: 0 });
    camera.fov = 1.0471975;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const runtimes = (await asset.flowGraphRuntimes) ?? [];
    await enableFlowGraphPointerPicking(scene);
    await registerScene(scene);
    await startEngine(engine);

    const loadedGraph = asset.flowGraphs?.[0];
    const displayOffset = (materialIndex: number): unknown =>
        loadedGraph?.accessors[`/materials/${materialIndex}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset`]?.get();
    (window as unknown as { __scene304?: unknown }).__scene304 = {
        selectedNumber: (): unknown => runtimes[0]?.context.userVariables["0"],
        displayOffsets: (): unknown[] => [displayOffset(4), displayOffset(5)],
    };
    canvas.dataset.graphCount = String(runtimes.length);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
