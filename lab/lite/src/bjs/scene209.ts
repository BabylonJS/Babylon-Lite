// BJS reference for scene 209 — floating-origin Havok physics (multi-region).
//
// Mirrors lab/lite/src/lite/scene209.ts exactly. The intended substrate
// difference is `useLargeWorldRendering: true` on the engine, which both
// enables BJS eye-relative rendering AND sets `scene.floatingOriginMode`, so
// the Havok plugin simulates bodies in per-region local coordinates (multi-
// region floating origin). At world (~5e6, *, ~5e6) this keeps the float32
// solver precise and the sphere settles exactly on the ground — the behaviour
// scene209.ts asserts for Lite.
//
// IMPORTANT: every geometry/material/camera/light/physics parameter below MUST
// stay in sync with lab/lite/src/lite/scene209.ts.
import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene209.ts. */
const OFFSET = 5_000_000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new FreeCamera("camera1", new Vector3(OFFSET, 5, OFFSET - 10), scene);
    camera.setTarget(new Vector3(OFFSET, 0, OFFSET));

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.set(OFFSET, 4, OFFSET);

    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);
    ground.position.set(OFFSET, 0, OFFSET);

    // Havok physics — floatingOriginMode is on (set by useLargeWorldRendering),
    // so the plugin uses multi-region floating origin automatically.
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(true, havokInstance);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.75 }, scene);
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let settleFrames = 0;
    let settled = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        if (!settled) {
            const y = sphere.position.y;
            if (Math.abs(y - 1.0) < 0.05) {
                settleFrames++;
                if (settleFrames > 30) {
                    settled = true;
                    canvas.dataset.initMs = String(performance.now() - __initStart);
                    canvas.dataset.offset = String(OFFSET);
                    canvas.dataset.useLargeWorldRendering = "true";
                    canvas.dataset.ready = "true";
                }
            } else {
                settleFrames = 0;
            }
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
