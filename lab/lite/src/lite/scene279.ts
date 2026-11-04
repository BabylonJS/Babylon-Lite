// Scene 279: fixed-topology line update plus thin-instance matrices and colors.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createLineMaterial,
    createLineSystem,
    createSceneContext,
    registerScene,
    setThinInstanceColors,
    setThinInstances,
    startEngine,
    updateLineSystem,
} from "babylon-lite";

const INITIAL = [
    [
        { x: -1, y: -0.6, z: 0 },
        { x: -0.35, y: 0.75, z: 0 },
        { x: 0.35, y: -0.05, z: 0 },
        { x: 1, y: 0.65, z: 0 },
    ],
] as const;
const UPDATED = [
    [
        { x: -1.1, y: -0.8, z: 0 },
        { x: -0.25, y: 0.95, z: 0 },
        { x: 0.25, y: -0.15, z: 0 },
        { x: 1.1, y: 0.8, z: 0 },
    ],
] as const;

const INSTANCE_POSITIONS = [
    [-3.6, 1.5, 0],
    [0, 1.5, 0],
    [3.6, 1.5, 0],
    [-1.8, -1.7, 0],
    [1.8, -1.7, 0],
] as const;

function createMatrices(): Float32Array {
    const matrices = new Float32Array(INSTANCE_POSITIONS.length * 16);
    for (let i = 0; i < INSTANCE_POSITIONS.length; i++) {
        const [x, y, z] = INSTANCE_POSITIONS[i]!;
        const offset = i * 16;
        matrices[offset] = 1;
        matrices[offset + 5] = 1;
        matrices[offset + 10] = 1;
        matrices[offset + 12] = x;
        matrices[offset + 13] = y;
        matrices[offset + 14] = z;
        matrices[offset + 15] = 1;
    }
    return matrices;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.025, b: 0.05, a: 1 };

    const material = createLineMaterial({
        useVertexAlpha: true,
        useThinInstances: true,
        useThinInstanceColors: true,
    });
    const mesh = createLineSystem(engine, { name: "updated-instanced-lines", lines: INITIAL, material });
    updateLineSystem(engine, mesh, { lines: UPDATED });
    setThinInstances(mesh, createMatrices(), INSTANCE_POSITIONS.length);
    setThinInstanceColors(mesh, new Float32Array([1, 0.2, 0.2, 0.9, 0.2, 1, 0.35, 0.75, 0.2, 0.55, 1, 0.65, 1, 0.75, 0.15, 0.55, 0.85, 0.25, 1, 0.45]));
    addToScene(scene, mesh);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 12, { x: 0, y: 0, z: 0 });
    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.updated = "true";
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
