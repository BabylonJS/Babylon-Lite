// Scene 171: Navigation crowd with single agent + computed path (port of playground #DPDNVH#2)
//
// First frame: build navmesh from nav_test.glb, place one crowd agent at
// {-2, 0, 3}, compute path to {2, 0, -2}, draw it as a tube. Set ready.
//
// With `?freeze=1`: `nav.timeFactor = 0` keeps the crowd stationary — used by
// parity tests so screenshot matches Lite exactly.

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
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/loaders/glTF/2.0";

const NAV_MESH_URL = "/models/nav_test.glb";

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
    const agentSpawn = nav.getClosestPoint(new Vector3(4, 0, 5));

    // Bake size + half-height Y offset into the mesh vertices so the box origin sits at its
    // BOTTOM (matches playground DPDNVH#2 which does the same on a cylinder). The
    // BJS addons RecastJSCrowd auto-updates `agentBox.position = recast.position()` each frame
    // with NO offset; baking the offset into vertices keeps the box sitting on top of the
    // navmesh in live mode (otherwise it sinks half a height into the floor).
    const agentBox = MeshBuilder.CreateBox("agent", { size: 1 }, scene);
    agentBox.scaling = new Vector3(agentParams.radius * 2, agentParams.height, agentParams.radius * 2);
    agentBox.position.y = agentParams.height / 2;
    agentBox.bakeCurrentTransformIntoVertices();
    const agentMat = new StandardMaterial("agentMat", scene);
    agentMat.diffuseColor = new Color3(0.7, 0.3, 0.7);
    agentBox.material = agentMat;
    agentBox.position = agentSpawn.clone();

    crowd.addAgent(agentSpawn, agentParams as never, agentBox);

    const target = nav.getClosestPoint(new Vector3(-3, 3, -3));
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
