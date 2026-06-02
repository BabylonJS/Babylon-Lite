// Scene 170: Navigation initialization — Recast V2 navmesh + crowd agent (matches playground #KVQP83#0)

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";
import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new FreeCamera("camera", new Vector3(-6, 4, -8), scene);
    camera.setTarget(Vector3.Zero());

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6, subdivisions: 2 }, scene);

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 16 }, scene);
    sphere.position.y = 1;

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.scaling.set(1, 3, 1);
    box.position.set(1, 1.5, 0);

    await RecastCore.init();

    const nav = await CreateNavigationPluginAsync({ instance: { ...RecastCore, ...RecastGenerators } });
    nav.createNavMesh([ground, sphere, box], {
        cs: 0.2,
        ch: 0.2,
        walkableSlopeAngle: 90,
        walkableHeight: 1,
        walkableClimb: 1,
        walkableRadius: 1,
        maxEdgeLen: 12,
        maxSimplificationError: 1.3,
        minRegionArea: 8,
        mergeRegionArea: 20,
        maxVertsPerPoly: 6,
        detailSampleDist: 6,
        detailSampleMaxError: 1,
        maxObstacles: 0,
    });

    const navDebug = nav.createDebugNavMesh(scene);
    const debugPositions = navDebug.getVerticesData(VertexBuffer.PositionKind);
    if (debugPositions) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < debugPositions.length; i++) {
            hash ^= Math.round(debugPositions[i]! * 100000);
            hash = Math.imul(hash, 0x01000193);
        }
        console.log("[nav] debug mesh positionsHash:", hash);
    }
    navDebug.position.y = 0.01;
    const navDebugMat = new StandardMaterial("navDebug", scene);
    navDebugMat.diffuseColor = new Color3(0.1, 0.2, 1);
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;

    const crowd = nav.createCrowd(10, 0.1, scene);
    const agentSpawn = nav.getClosestPoint(new Vector3(-2.0, 0.1, -1.8));
    const agentBox = MeshBuilder.CreateBox("agent", { size: 0.2 }, scene);
    const agentMat = new StandardMaterial("agentMat", scene);
    agentMat.diffuseColor = new Color3(0.7, 0.3, 0.7);
    agentBox.material = agentMat;
    agentBox.position.copyFrom(agentSpawn);

    crowd.addAgent(
        agentSpawn,
        {
            radius: 0.1,
            height: 0.2,
            maxAcceleration: 4.0,
            maxSpeed: 1.0,
            collisionQueryRange: 0.5,
            pathOptimizationRange: 0.0,
            separationWeight: 1.0,
            reachRadius: 0.1,
        } as never,
        agentBox
    );

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());

    let frame = 0;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
        frame++;
        if (frame === 3) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
