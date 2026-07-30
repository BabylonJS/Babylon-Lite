import {
    addTextRenderable,
    createDefaultTextData,
    createEngine,
    createFreeCamera,
    createSceneContext,
    createTextRenderable,
    loadFont,
    registerScene,
    setAlphaToCoverage,
    startEngine,
} from "babylon-lite";

const FRONT: readonly [number, number, number, number] = [242 / 255, 31 / 255, 41 / 255, 1];
const REAR: readonly [number, number, number, number] = [26 / 255, 217 / 255, 83 / 255, 1];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };
    scene.camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });

    const font = await loadFont("/fonts/Roboto-Regular.ttf");
    const frontData = createDefaultTextData(font, 180, "A2C", FRONT);
    const rearData = createDefaultTextData(font, 180, "A2C", REAR);
    const scale = 0.012;
    const position = { x: -frontData.width * scale * 0.5, y: frontData.height * scale * 0.5 };

    const front = createTextRenderable(frontData, {
        position: { x: position.x, y: position.y, z: 0 },
        scaling: { x: scale, y: scale, z: scale },
        order: 100,
    });
    const rear = createTextRenderable(rearData, {
        position: { x: position.x, y: position.y, z: 0.2 },
        scaling: { x: scale, y: scale, z: scale },
        order: 101,
    });
    setAlphaToCoverage(front, true);
    setAlphaToCoverage(rear, true);
    addTextRenderable(scene, front);
    addTextRenderable(scene, rear);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.sampleCount = String(engine.msaaSamples);
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
