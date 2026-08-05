// Scene 278: public line-system API with uniform and per-point RGBA colors.

import { addToScene, createArcRotateCamera, createEngine, createLineSystem, createSceneContext, registerScene, startEngine } from "babylon-lite";

const UNIFORM_LINES = [
    [
        { x: -4.6, y: -2.1, z: 0 },
        { x: -4.6, y: 2.1, z: 0 },
        { x: -1.4, y: 2.1, z: 0 },
        { x: -1.4, y: -2.1, z: 0 },
        { x: -4.6, y: -2.1, z: 0 },
    ],
    [
        { x: -4.2, y: -1.6, z: 0 },
        { x: -1.8, y: 1.6, z: 0 },
    ],
    [
        { x: -4.2, y: 1.6, z: 0 },
        { x: -1.8, y: -1.6, z: 0 },
    ],
] as const;

const COLOR_LINES = [
    [
        { x: 1.4, y: -2.1, z: 0 },
        { x: 3.0, y: 2.2, z: 0 },
        { x: 4.6, y: -2.1, z: 0 },
        { x: 1.4, y: 0.5, z: 0 },
        { x: 4.6, y: 0.5, z: 0 },
        { x: 1.4, y: -2.1, z: 0 },
    ],
    [
        { x: 1.6, y: -1.5, z: 0 },
        { x: 4.4, y: 1.6, z: 0 },
    ],
] as const;

const COLOR_VALUES = [
    [
        { r: 1, g: 0.2, b: 0.15, a: 0.9 },
        { r: 1, g: 0.85, b: 0.1, a: 0.75 },
        { r: 0.15, g: 0.9, b: 0.35, a: 0.65 },
        { r: 0.1, g: 0.75, b: 1, a: 0.55 },
        { r: 0.65, g: 0.25, b: 1, a: 0.45 },
        { r: 1, g: 0.2, b: 0.15, a: 0.9 },
    ],
    [
        { r: 0.2, g: 0.9, b: 1, a: 0.35 },
        { r: 1, g: 0.25, b: 0.75, a: 0.8 },
    ],
] as const;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.025, g: 0.035, b: 0.065, a: 1 };

    addToScene(
        scene,
        createLineSystem(engine, {
            name: "uniform-lines",
            lines: UNIFORM_LINES,
            color: { r: 0.25, g: 0.85, b: 1, a: 1 },
            useVertexAlpha: false,
        })
    );
    addToScene(
        scene,
        createLineSystem(engine, {
            name: "vertex-color-lines",
            lines: COLOR_LINES,
            colors: COLOR_VALUES,
            useVertexAlpha: true,
        })
    );

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 12, { x: 0, y: 0, z: 0 });
    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
