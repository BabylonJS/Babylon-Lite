// Scene 172: Navigation crowd + tile-cache with 2 static obstacles (port of playground #DPDNVH#3)

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";
import { WaitForFullTileCacheUpdate } from "@babylonjs/addons/navigation/common/tile-cache";
import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const freeze = new URLSearchParams(window.location.search).get("freeze") === "1";
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("cam", 1.8, 1.0, 14, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10, subdivisions: 2 }, scene);

    await RecastCore.init();
    const nav = await CreateNavigationPluginAsync({ instance: { ...RecastCore, ...RecastGenerators } });
    const maxAgentRadius = 0.15;
    const navResult = nav.createNavMesh([ground], {
        cs: 0.1,
        ch: 0.05,
        tileSize: 32,
        maxObstacles: 32,
        keepIntermediates: true,
    } as never) as unknown as { navMesh: never; tileCache: never };

    nav.addCylinderObstacle(new Vector3(1.5, 0, -1.5), 1, 0.5);
    nav.addBoxObstacle(new Vector3(-2, 1, 1), new Vector3(1, 1, 1), 0.2);
    WaitForFullTileCacheUpdate(navResult.navMesh, navResult.tileCache);

    const obstacleMat = new StandardMaterial("obstacleMat", scene);
    obstacleMat.diffuseColor = new Color3(0, 0, 0);
    obstacleMat.emissiveColor = new Color3(0.7, 0.3, 1);

    function addEdgeTube(edgeStart: Vector3, edgeEnd: Vector3, position: Vector3, rotationY: number) {
        const tube = MeshBuilder.CreateTube("edge", { path: [edgeStart, edgeEnd], radius: 0.02, tessellation: 4 }, scene);
        tube.material = obstacleMat;
        tube.position = position.clone();
        tube.rotation.y = rotationY;
        return tube;
    }

    function addBoxWireframe(half: Vector3, position: Vector3, rotationY: number) {
        const corners = [
            new Vector3(-half.x, -half.y, -half.z), new Vector3(half.x, -half.y, -half.z),
            new Vector3(half.x, -half.y, half.z), new Vector3(-half.x, -half.y, half.z),
            new Vector3(-half.x, half.y, -half.z), new Vector3(half.x, half.y, -half.z),
            new Vector3(half.x, half.y, half.z), new Vector3(-half.x, half.y, half.z),
        ];
        const edgeIdx: [number, number][] = [
            [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
        ];
        for (const [a, b] of edgeIdx) {
            addEdgeTube(corners[a]!, corners[b]!, position, rotationY);
        }
    }

    function addCylinderWireframe(height: number, radius: number, segments: number, position: Vector3) {
        const h = height / 2;
        for (let i = 0; i < segments; i++) {
            const a1 = (i / segments) * Math.PI * 2;
            const a2 = ((i + 1) / segments) * Math.PI * 2;
            const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
            const x2 = Math.cos(a2) * radius, z2 = Math.sin(a2) * radius;
            addEdgeTube(new Vector3(x1, h, z1), new Vector3(x2, h, z2), position, 0);
            addEdgeTube(new Vector3(x1, -h, z1), new Vector3(x2, -h, z2), position, 0);
        }
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
            addEdgeTube(new Vector3(x, h, z), new Vector3(x, -h, z), position, 0);
        }
    }

    addCylinderWireframe(0.5, 1, 12, new Vector3(1.5, 0, -1.5));
    addBoxWireframe(new Vector3(1, 1, 1), new Vector3(-2, 1, 1), 0.2);

    const navDebug = nav.createDebugNavMesh(scene);
    navDebug.position.y = 0.02;
    const navDebugMat = new StandardMaterial("navDebug", scene);
    navDebugMat.diffuseColor = new Color3(0.1, 0.2, 1);
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;

    const agentParams = {
        radius: 0.15,
        height: 0.5,
        maxAcceleration: 4.0,
        maxSpeed: 1.0,
        collisionQueryRange: 0.5,
        pathOptimizationRange: 0.0,
        separationWeight: 1.0,
        reachRadius: 0.15,
    };

    const crowd = nav.createCrowd(1, maxAgentRadius, scene);
    const agentSpawn = nav.getClosestPoint(new Vector3(-3, 0, 3.5));

    const agentBox = MeshBuilder.CreateBox("agent", { size: 1 }, scene);
    agentBox.scaling = new Vector3(agentParams.radius * 2, agentParams.height, agentParams.radius * 2);
    const agentMat = new StandardMaterial("agentMat", scene);
    agentMat.diffuseColor = new Color3(0.7, 0.3, 0.7);
    agentBox.material = agentMat;
    agentBox.position = agentSpawn.clone();
    agentBox.position.y += agentParams.height / 2;
    crowd.addAgent(agentSpawn, agentParams as never, agentBox);

    const target = nav.getClosestPoint(new Vector3(3, 0, -3.5));
    const pathPoints = nav.computePath(agentSpawn, target);
    if (pathPoints.length < 2) {
        throw new Error(`BJS path computation failed: ${pathPoints.length} points`);
    }
    canvas.dataset.pathLen = String(pathPoints.length);

    const pathDraw = pathPoints.map((p) => new Vector3(p.x, p.y + 0.2, p.z));
    const pathTube = MeshBuilder.CreateTube("pathTube", { path: pathDraw, radius: 0.04, tessellation: 12 }, scene);
    const pathMat = new StandardMaterial("pathMat", scene);
    pathMat.diffuseColor = new Color3(0, 0, 0);
    pathMat.emissiveColor = new Color3(1, 0, 0);
    pathTube.material = pathMat;

    if (freeze) {
        nav.timeFactor = 0;
    } else {
        crowd.agentGoto(0, target);
    }

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => eng._drawCalls?.fetchNewFrame());

    let frame = 0;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
        frame++;
        if (frame === 1) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
