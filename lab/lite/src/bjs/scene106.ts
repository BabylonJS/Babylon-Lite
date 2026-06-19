// Scene 106: Physics V2 — Havok motion-types × prestep-types grid (port of PG #E9R16H#1).
//
// Babylon.js reference. A 2×3 grid: rows are prestep type [TELEPORT, ACTION], columns are motion
// type [STATIC, ANIMATED, DYNAMIC]. Each cell is a 10×1×10 box platform (motion + prestep type set
// per cell) with a falling cylinder (diameter 2, height 2) resting 0.5 above. Every box node is
// nudged each step (x += cos(t)*0.03; z += sin(t)*0.03; y = 0); the prestep type decides how that
// motion drives Havok. Text labels from the playground are intentionally omitted.

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType, PhysicsMotionType, PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;

// Deterministic 6-colour palette, indexed by prestep*3 + motion. Identical to the Lite scene.
const PALETTE: [number, number, number][] = [
    [0.85, 0.25, 0.25],
    [0.25, 0.75, 0.3],
    [0.25, 0.45, 0.85],
    [0.9, 0.8, 0.25],
    [0.8, 0.3, 0.8],
    [0.25, 0.8, 0.8],
];

// Per-step animation increment: mirrors the playground's `t += engine.getDeltaTime()/300` at 60 fps.
const T_PER_STEP = 1000 / PHYSICS_FPS / 300;

function readCaptureAfterFrames(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
    }
    const value = params.get("captureAfter");
    if (value === null) {
        return null;
    }
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * PHYSICS_FPS) : null;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);
    // Deterministic frame delta so the live-captured reference is stable across runs.
    scene.useConstantAnimationDeltaTime = true;

    // Camera — FreeCamera at (-24, 30, 5) targeting (12, 0, 5)
    const camera = new FreeCamera("camera1", new Vector3(-24, 30, 5), scene);
    camera.setTarget(new Vector3(12, 0, 5));

    // Hemispheric light
    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    // Havok physics
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    const motions = [PhysicsMotionType.STATIC, PhysicsMotionType.ANIMATED, PhysicsMotionType.DYNAMIC];
    const presteps = [PhysicsPrestepType.TELEPORT, PhysicsPrestepType.ACTION];

    const boxes: Mesh[] = [];

    for (let prestep = 0; prestep < 2; prestep++) {
        for (let motion = 0; motion < 3; motion++) {
            const cylinder = MeshBuilder.CreateCylinder("cylinder", { diameter: 2, height: 2 }, scene);
            cylinder.position.set(motion * 12, 2, prestep * 12);
            const cylMat = new StandardMaterial("mat", scene);
            const col = PALETTE[prestep * 3 + motion]!;
            cylMat.diffuseColor = new Color3(col[0], col[1], col[2]);
            cylinder.material = cylMat;

            const box = MeshBuilder.CreateBox("box", { width: 10, height: 1, depth: 10 }, scene);
            box.position.set(motion * 12, 0, prestep * 12);
            box.material = new StandardMaterial("boxMat", scene);

            new PhysicsAggregate(cylinder, PhysicsShapeType.CYLINDER, { mass: 1, restitution: 0.1, friction: 1 }, scene);
            const boxAggregate = new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: motion, friction: 1 }, scene);
            boxAggregate.body.setMotionType(motions[motion]!);
            boxAggregate.body.setPrestepType(presteps[prestep]!);
            boxes.push(box);
        }
    }

    let t = 0;
    let simulatedFrames = 0;
    let captureQueued = false;
    // Advance the box-nudge animation count-based from the fixed step so Lite and BJS match exactly.
    scene.onAfterPhysicsObservable.add(() => {
        const c = Math.cos(t) * 0.03;
        const s = Math.sin(t) * 0.03;
        for (let i = 0; i < boxes.length; i++) {
            const p = boxes[i]!.position;
            p.set(p.x + c, 0, p.z + s);
        }
        t += T_PER_STEP;

        simulatedFrames++;
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                engine.stopRenderLoop();
            }, 0);
        }
    });

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
