// Scene 40: Physics V2 — Havok sphere drop (matches playground #Z8HTUN#1)

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

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    // Camera — FreeCamera at (0, 5, -10) looking at origin
    const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());

    // Hemispheric light
    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    // Sphere — diameter 2, starts at y=4
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.y = 4;

    // Ground — 10x10
    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);

    // Havok physics
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(true, havokInstance);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    // Dynamic sphere body
    const _sphereAggregate = new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.75 }, scene);

    // Static ground body
    const _groundAggregate = new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // Render and wait for sphere to settle
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

        // Wait for sphere to come to rest on the ground (y ≈ 1.0)
        if (!settled) {
            const y = sphere.position.y;
            if (Math.abs(y - 1.0) < 0.05) {
                settleFrames++;
                if (settleFrames > 30) {
                    settled = true;
                    canvas.dataset.initMs = String(performance.now() - __initStart);
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
