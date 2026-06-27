// Scene 261: Temporal Anti-Aliasing (TAA), frame-graph based.
//
// Three rotated boxes with sharp diagonal silhouette edges are rendered into a
// single-sample offscreen target, then a TAA post-process task accumulates
// sub-pixel-jittered frames into an anti-aliased image written to the swapchain.
//
// The Lite TAA is a pure frame-graph node: source render task at the start of the
// chain, `createTaaPostProcessTask` at the end. TAA drives the per-frame projection
// jitter into the source task itself, so the whole effect lives inside the frame
// graph and can be injected into any chain.
//
// The scene renders many frames so the temporal accumulation converges, then freezes
// (deterministic golden) and reports ready.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createStandardMaterial,
    createTaaPostProcessTask,
    registerScene,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const ACCUMULATION_FRAMES = 160;

function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 10, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    addToScene(scene, createHemisphericLight([0, 1, 0]));

    // Axis-angle quaternion (axis normalized), identical to the BJS reference, so the
    // box orientations match exactly regardless of Euler convention — the scene tests
    // TAA, not rotation order.
    const axisAngleQuat = (ax: number, ay: number, az: number, angle: number): [number, number, number, number] => {
        const len = Math.hypot(ax, ay, az) || 1;
        const s = Math.sin(angle / 2) / len;
        return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
    };

    const addBox = (color: [number, number, number], x: number, axis: [number, number, number], angle: number): void => {
        const box: Mesh = createBox(engine, 2);
        const mat = createStandardMaterial();
        mat.diffuseColor = color;
        mat.specularColor = [0, 0, 0];
        box.material = mat;
        box.position.x = x;
        const q = axisAngleQuat(axis[0], axis[1], axis[2], angle);
        box.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        addToScene(scene, box);
    };

    addBox([0.85, 0.32, 0.22], -2.6, [1, 1, 0], 0.9);
    addBox([0.3, 0.78, 0.4], 0, [0, 1, 1], 0.8);
    addBox([0.32, 0.5, 0.9], 2.6, [1, 0.5, 0.5], 1.0);

    // Single-sample source target (TAA replaces MSAA; the post-process needs a
    // single-sample source).
    const sourceTarget = createRenderTarget({
        lbl: "scene261-source",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const sourceTask = createRenderTask(
        {
            name: "scene261-source",
            rt: sourceTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );
    addTaskAtStart(scene, sourceTask);

    const taa = createTaaPostProcessTask(
        {
            name: "scene261-taa",
            sourceTexture: sourceTarget,
            sourceRenderTask: sourceTask,
            targetTexture: engine.scRT,
            factor: 0.05,
            samples: 8,
        },
        engine,
        scene
    );
    addTask(scene, taa);

    await registerScene(scene);
    taa.updateUniforms();
    await startEngine(engine);

    // Accumulate, then freeze so the golden is deterministic.
    for (let i = 0; i < ACCUMULATION_FRAMES; i++) {
        await nextFrame();
    }
    stopEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
