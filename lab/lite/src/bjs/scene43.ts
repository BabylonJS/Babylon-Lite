// Babylon.js reference — Scene 43: Parametric proximity path (circle back-port of PG #I6AR8X#21)

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

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

function makeCirclePath(samples: number): Vector3[] {
    const pts: Vector3[] = [];
    for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * Math.PI * 2;
        pts.push(new Vector3(Math.cos(t) * CIRCLE_RADIUS, BALL_SIZE / 4, Math.sin(t) * CIRCLE_RADIUS));
    }
    return pts;
}

function circlePosition(frame: number): BlockPoint {
    const t = ((frame % TOTAL_FRAMES) / TOTAL_FRAMES) * Math.PI * 2;
    return { x: Math.cos(t) * CIRCLE_RADIUS, y: BALL_SIZE / 4, z: Math.sin(t) * CIRCLE_RADIUS };
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

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureFrame = readCaptureFrame();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("cam", Math.PI / 3, 0.85, Math.max(WIDTH, HEIGHT) * 1.35, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const ball = MeshBuilder.CreateSphere("ball", { diameter: BALL_SIZE, segments: 32 }, scene);
    const ballMat = new StandardMaterial("ballMat", scene);
    ballMat.diffuseColor = new Color3(1, 1, 1);
    ball.material = ballMat;

    const radiusSphere = MeshBuilder.CreateSphere("radiusSphere", { diameter: QUERY_RADIUS * 2, segments: 32 }, scene);
    const radiusMat = new StandardMaterial("radiusMat", scene);
    radiusMat.diffuseColor = new Color3(0, 1, 0);
    radiusMat.alpha = 0.5;
    radiusSphere.material = radiusMat;

    const pathMesh = MeshBuilder.CreateTube("circlePath", { path: makeCirclePath(96), radius: 0.35, tessellation: 8 }, scene);
    const pathMat = new StandardMaterial("pathMat", scene);
    pathMat.emissiveColor = new Color3(0.35, 0.75, 1);
    pathMat.diffuseColor = new Color3(0.1, 0.35, 0.5);
    pathMesh.material = pathMat;

    const ground = MeshBuilder.CreateGround("ground", { width: WIDTH, height: HEIGHT }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.45, 0.45, 0.45);
    ground.material = groundMat;
    ground.isPickable = false;

    const baseBlock = MeshBuilder.CreateCylinder("baseBlock", { diameter: BLOCK_SIZE, height: BLOCK_SIZE, subdivisions: 10, tessellation: 48 }, scene);
    const blockMat = new StandardMaterial("baseMat", scene);
    baseBlock.material = blockMat;

    const matrixBuffer = new Float32Array(TOTAL_BLOCKS * 16);
    const colorBuffer = new Float32Array(TOTAL_BLOCKS * 4);
    const matrix = Matrix.Identity();
    const blocks: BlockPoint[] = [];
    const seed = { value: 0x42_43_21 };
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        const x = (rand(seed) - 0.5) * WIDTH;
        const z = (rand(seed) - 0.5) * HEIGHT;
        const y = BLOCK_SIZE / 2;
        matrix.setTranslationFromFloats(x, y, z);
        matrix.copyToArray(matrixBuffer, i * 16);
        blocks.push({ x, y, z });
        colorBuffer[i * 4] = rand(seed);
        colorBuffer[i * 4 + 1] = rand(seed);
        colorBuffer[i * 4 + 2] = rand(seed);
        colorBuffer[i * 4 + 3] = 1;
    }
    baseBlock.thinInstanceSetBuffer("matrix", matrixBuffer, 16);
    baseBlock.thinInstanceSetBuffer("color", colorBuffer, 4);

    const highlight = MeshBuilder.CreateCylinder("highlight", { diameter: BLOCK_SIZE * 1.5, height: BLOCK_SIZE * 1.5, tessellation: 48 }, scene);
    const highlightMat = new StandardMaterial("highlightMat", scene);
    highlightMat.emissiveColor = new Color3(1, 1, 1);
    highlightMat.diffuseColor = new Color3(1, 1, 1);
    highlight.material = highlightMat;

    const eng = engine as any;
    let frame = 0;
    let captureQueued = false;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
        const p = circlePosition(frame);
        ball.position.set(p.x, p.y, p.z);
        radiusSphere.position.set(p.x, p.y, p.z);
        const nearest = nearestBlock(blocks, p);
        if (nearest) {
            highlight.isVisible = true;
            highlight.position.set(nearest.x, nearest.y, nearest.z);
        } else {
            highlight.isVisible = false;
        }
        if (captureFrame !== null && !captureQueued && frame >= captureFrame) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                engine.stopRenderLoop();
            }, 0);
        }
        frame++;
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
})().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
