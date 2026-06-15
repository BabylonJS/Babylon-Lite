// Babylon.js reference — Scene 44: Physics sleeping towers (playground #KJ0945#1)

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;
const DROP_AFTER_MS = 2_000;

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

function colorFor(index: number): Color3 {
    const r = ((index * 73 + 41) & 255) / 255;
    const g = ((index * 151 + 89) & 255) / 255;
    const b = ((index * 211 + 157) & 255) / 255;
    return new Color3(r, g, b);
}

function createBoxes(size: number, numBoxes: number, startAsleep: boolean, pos: Vector3, yOffset: number, scene: Scene, colorOffset: number): void {
    for (let i = 0; i < numBoxes; i++) {
        const box = MeshBuilder.CreateBox("box", { size }, scene);
        const material = new StandardMaterial("boxMat", scene);
        material.diffuseColor = colorFor(colorOffset + i);
        material.specularColor = new Color3(0.08, 0.08, 0.08);
        box.material = material;
        box.position.copyFrom(pos);
        box.position.y += i * (yOffset + size) + 0.5;
        new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 1, startAsleep }, scene);
    }
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new FreeCamera("camera1", new Vector3(0, 3, -15), scene);
    camera.setTarget(new Vector3(0, 3, 0));
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.5, 0.5, 0.5);
    ground.material = groundMat;

    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    scene.enablePhysics(new Vector3(0, -1, 0), hk);

    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    createBoxes(1, 3, true, new Vector3(-2, 0, 0), 0.5, scene, 0);
    createBoxes(1, 3, false, new Vector3(2, 0, 0), 0.5, scene, 10);

    window.setTimeout(() => {
        createBoxes(0.2, 1, false, new Vector3(-2, 5, 0), 0, scene, 20);
        createBoxes(0.2, 1, false, new Vector3(2, 5, 0), 0, scene, 21);
    }, DROP_AFTER_MS);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        const now = performance.now();
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(now - __initStart);
            canvas.dataset.ready = "true";
        } else {
            simulatedFrames++;
        }
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => {
                engine.stopRenderLoop();
            }, 0);
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
