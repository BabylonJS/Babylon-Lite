/** GPU Picking test — creates a sphere at origin, picks center & corner,
 *  tests both basic and detailed picking. Exposes results on window for Playwright. */

import { createEngine, startEngine, stopEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, createSphere, createStandardMaterial, addToScene, createGpuPicker, pickAsync, disposePicker, enableDetailedPicking, getPickedNormal, getPickedUV, registerScene } from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

interface PickTestResults {
    ready: boolean;
    error: string | null;
    centerPick: {
        hit: boolean;
        meshName: string | null;
        distance: number;
        pickedPoint: [number, number, number] | null;
        faceId: number;
        bu: number;
        bv: number;
        thinInstanceIndex: number;
        normal: [number, number, number] | null;
        uv: [number, number] | null;
    } | null;
    missPick: {
        hit: boolean;
    } | null;
}

const results: PickTestResults = {
    ready: false,
    error: null,
    centerPick: null,
    missPick: null,
};
(window as any).__pickTest = results;

async function run(): Promise<void> {
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);

        scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

        const sphere = createSphere(engine, { segments: 16 });
        sphere.name = "test-sphere";
        sphere.material = createStandardMaterial();
        addToScene(scene, sphere);

        await registerScene(engine, scene);
    await startEngine(engine);

        // Let a few frames render so GPU resources are fully initialized
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => requestAnimationFrame(r));
        }

        // Create picker with detailed picking enabled
        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);

        // Pick center of canvas — should hit the sphere
        const cx = canvas.clientWidth / 2;
        const cy = canvas.clientHeight / 2;
        const centerInfo = await pickAsync(picker, cx, cy);

        results.centerPick = {
            hit: centerInfo.hit,
            meshName: centerInfo.pickedMesh?.name ?? null,
            distance: centerInfo.distance,
            pickedPoint: centerInfo.pickedPoint,
            faceId: centerInfo.faceId,
            bu: centerInfo.bu,
            bv: centerInfo.bv,
            thinInstanceIndex: centerInfo.thinInstanceIndex,
            normal: getPickedNormal(centerInfo),
            uv: getPickedUV(centerInfo),
        };

        // Pick corner — should miss (background)
        const missInfo = await pickAsync(picker, 0, 0);
        results.missPick = {
            hit: missInfo.hit,
        };

        disposePicker(picker);
        stopEngine(engine);

        results.ready = true;
        canvas.dataset.ready = "true";
    } catch (e: any) {
        results.error = e.message;
        results.ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
