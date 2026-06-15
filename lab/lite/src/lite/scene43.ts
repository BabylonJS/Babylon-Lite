// Scene 43: Parametric proximity path — circle-path replacement for PG #I6AR8X#21 Catmull-Rom demo.

import {
    addToScene,
    createArcRotateCamera,
    createCylinder,
    createEngine,
    createGround,
    createHemisphericLight,
    createSphere,
    createStandardMaterial,
    createTube,
    attachControl,
    onBeforeRender,
    registerScene,
    setThinInstanceColors,
    setThinInstances,
    startEngine,
    stopEngine,
    createSceneContext,
} from "babylon-lite";

const TOTAL_FRAMES = 480;
const WIDTH = 200;
const HEIGHT = 200;
const BLOCK_SIZE = 4;
const BALL_SIZE = 2;
const TOTAL_BLOCKS = 100;
const CIRCLE_RADIUS = 50;
const QUERY_RADIUS = 10;

interface BlockPoint {
    x: number;
    y: number;
    z: number;
}

function readCaptureFrame(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
    }
    return null;
}

function rand(seed: { value: number }): number {
    seed.value = (seed.value * 1664525 + 1013904223) >>> 0;
    return seed.value / 0x100000000;
}

function makeCirclePath(samples: number): BlockPoint[] {
    const pts: BlockPoint[] = [];
    for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * Math.PI * 2;
        pts.push({ x: Math.cos(t) * CIRCLE_RADIUS, y: BALL_SIZE / 4, z: Math.sin(t) * CIRCLE_RADIUS });
    }
    return pts;
}

function circlePosition(frame: number): BlockPoint {
    const t = ((frame % TOTAL_FRAMES) / TOTAL_FRAMES) * Math.PI * 2;
    return { x: Math.cos(t) * CIRCLE_RADIUS, y: BALL_SIZE / 4, z: Math.sin(t) * CIRCLE_RADIUS };
}

function setTranslation(matrix: Float32Array, offset: number, x: number, y: number, z: number): void {
    matrix[offset] = 1;
    matrix[offset + 1] = 0;
    matrix[offset + 2] = 0;
    matrix[offset + 3] = 0;
    matrix[offset + 4] = 0;
    matrix[offset + 5] = 1;
    matrix[offset + 6] = 0;
    matrix[offset + 7] = 0;
    matrix[offset + 8] = 0;
    matrix[offset + 9] = 0;
    matrix[offset + 10] = 1;
    matrix[offset + 11] = 0;
    matrix[offset + 12] = x;
    matrix[offset + 13] = y;
    matrix[offset + 14] = z;
    matrix[offset + 15] = 1;
}

function nearestBlock(blocks: readonly BlockPoint[], p: BlockPoint): BlockPoint | null {
    let best: BlockPoint | null = null;
    let bestD2 = Infinity;
    const maxD2 = QUERY_RADIUS * QUERY_RADIUS;
    for (const b of blocks) {
        const dx = b.x - p.x;
        const dy = b.y - BLOCK_SIZE / 2;
        const dz = b.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2 && d2 <= maxD2) {
            best = b;
            bestD2 = d2;
        }
    }
    return best;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const captureFrame = readCaptureFrame();

    const camera = createArcRotateCamera(Math.PI / 3, 0.85, Math.max(WIDTH, HEIGHT) * 1.35, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const ball = createSphere(engine, { diameter: BALL_SIZE, segments: 32 });
    const ballMat = createStandardMaterial();
    ballMat.diffuseColor = [1, 1, 1];
    ball.material = ballMat;
    addToScene(scene, ball);

    const radiusSphere = createSphere(engine, { diameter: QUERY_RADIUS * 2, segments: 32 });
    const radiusMat = createStandardMaterial();
    radiusMat.diffuseColor = [0, 1, 0];
    radiusMat.alpha = 0.5;
    radiusSphere.material = radiusMat;
    addToScene(scene, radiusSphere);

    const path = makeCirclePath(96);
    const pathMesh = createTube(engine, { path, radius: 0.35, tessellation: 8 });
    const pathMat = createStandardMaterial();
    pathMat.emissiveColor = [0.35, 0.75, 1];
    pathMat.diffuseColor = [0.1, 0.35, 0.5];
    pathMesh.material = pathMat;
    addToScene(scene, pathMesh);

    const ground = createGround(engine, { width: WIDTH, height: HEIGHT });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.45, 0.45, 0.45];
    ground.material = groundMat;
    ground.pickable = false;
    addToScene(scene, ground);

    const baseBlock = createCylinder(engine, { diameter: BLOCK_SIZE, height: BLOCK_SIZE, subdivisions: 10, tessellation: 48 });
    const blockMat = createStandardMaterial();
    blockMat.diffuseColor = [1, 1, 1];
    baseBlock.material = blockMat;

    const matrixBuffer = new Float32Array(TOTAL_BLOCKS * 16);
    const colorBuffer = new Float32Array(TOTAL_BLOCKS * 4);
    const blocks: BlockPoint[] = [];
    const seed = { value: 0x42_43_21 };
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        const x = (rand(seed) - 0.5) * WIDTH;
        const z = (rand(seed) - 0.5) * HEIGHT;
        const y = BLOCK_SIZE / 2;
        setTranslation(matrixBuffer, i * 16, x, y, z);
        blocks.push({ x, y, z });
        colorBuffer[i * 4] = rand(seed);
        colorBuffer[i * 4 + 1] = rand(seed);
        colorBuffer[i * 4 + 2] = rand(seed);
        colorBuffer[i * 4 + 3] = 1;
    }
    setThinInstances(baseBlock, matrixBuffer, TOTAL_BLOCKS);
    setThinInstanceColors(baseBlock, colorBuffer);
    addToScene(scene, baseBlock);

    const highlight = createCylinder(engine, { diameter: BLOCK_SIZE * 1.5, height: BLOCK_SIZE * 1.5, tessellation: 48 });
    const highlightMat = createStandardMaterial();
    highlightMat.emissiveColor = [1, 1, 1];
    highlightMat.diffuseColor = [1, 1, 1];
    highlight.material = highlightMat;
    addToScene(scene, highlight);

    let frame = 0;
    let captureQueued = false;
    onBeforeRender(scene, () => {
        const p = circlePosition(frame);
        ball.position.set(p.x, p.y, p.z);
        radiusSphere.position.set(p.x, p.y, p.z);
        const nearest = nearestBlock(blocks, p);
        if (nearest) {
            highlight.visible = true;
            highlight.position.set(nearest.x, nearest.y, nearest.z);
        } else {
            highlight.visible = false;
        }
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        if (captureFrame !== null && !captureQueued && frame >= captureFrame) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
        frame++;
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
