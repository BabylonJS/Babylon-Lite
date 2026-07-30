// Scene 174: Navigation with off-mesh connections (port of playground #DPDNVH#5).

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";
import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";
import "@babylonjs/loaders/glTF/2.0";

const NAV_MESH_URL = "/models/nav_test.glb";

const OFFMESH_CONNECTIONS = [
    {
        startPosition: { x: -4.501361846923828, y: 0.36645400524139404, z: 2.227370500564575 },
        endPosition: { x: -6.453944206237793, y: 0.4996081590652466, z: 1.6987327337265015 },
        radius: 0.3,
        area: 0,
        flags: 1,
        bidirectional: true,
    },
    {
        startPosition: { x: -0.2870096266269684, y: 3.9292590618133545, z: 2.564833402633667 },
        endPosition: { x: -1.4627689123153687, y: 2.778116226196289, z: 3.5469906330108643 },
        radius: 0.3,
        area: 0,
        flags: 1,
        bidirectional: false,
    },
    {
        startPosition: { x: -3.5109636783599854, y: 3.1664540767669678, z: 2.893442392349243 },
        endPosition: { x: -4.669801950454712, y: 0.36645400524139404, z: 2.135521173477173 },
        radius: 0.3,
        area: 0,
        flags: 1,
        bidirectional: false,
    },
];

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const freeze = new URLSearchParams(window.location.search).get("freeze") === "1";
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("cam", 1.8, 1.0, 20, new Vector3(0, 1, 0), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const result = await ImportMeshAsync(NAV_MESH_URL, scene);
    const staticMesh = result.meshes[1]!;

    await RecastCore.init();
    const nav = await CreateNavigationPluginAsync({ instance: { ...RecastCore, ...RecastGenerators } });
    const maxAgentRadius = 0.15;
    const cellSize = 0.05;
    nav.createNavMesh([staticMesh as never], {
        cs: cellSize,
        ch: 0.2,
        walkableRadius: Math.ceil(maxAgentRadius / cellSize),
        offMeshConnections: OFFMESH_CONNECTIONS,
        keepIntermediates: true,
        maxObstacles: 0,
    } as never);

    const navDebug = nav.createDebugNavMesh(scene);
    navDebug.position.y = 0.01;
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
    const agentSpawn = nav.getClosestPoint(new Vector3(-6, 0.5, 1.5));

    const agentBox = MeshBuilder.CreateBox("agent", { size: 1 }, scene);
    agentBox.scaling = new Vector3(agentParams.radius * 2, agentParams.height, agentParams.radius * 2);
    const agentMat = new StandardMaterial("agentMat", scene);
    agentMat.diffuseColor = new Color3(0.7, 0.3, 0.7);
    agentBox.material = agentMat;
    agentBox.position = agentSpawn.clone();
    agentBox.position.y += agentParams.height / 2;
    crowd.addAgent(agentSpawn, agentParams as never, agentBox);

    const target = nav.getClosestPoint(new Vector3(5, 0, -2));
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
