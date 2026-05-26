// Scene 174: Navigation with off-mesh connections (port of playground #DPDNVH#5).
//
// Loads nav_test.glb, registers three off-mesh connections matching the
// playground exactly (one bidirectional at ground level, two one-way that
// jump down from upper platforms). Computes a path from far-left to far-right
// so the route exercises a large portion of the navmesh.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createBox,
    createTube,
    createStandardMaterial,
    createMeshFromData,
    loadGltf,
    onBeforeRender,
    registerScene,
    attachControl,
    createNavigationPluginAsync,
    createNavMesh,
    createDebugNavMeshGeometry,
    getClosestPoint,
    computePath,
    createNavCrowd,
    addAgent,
    getAgentPosition,
    agentGoto,
    updateNavCrowd,
} from "babylon-lite";
import type { Mesh, OffMeshConnection } from "babylon-lite";

const NAV_MESH_URL = "/models/nav_test.glb";
const AGENT_START = { x: -6, y: 0.5, z: 1.5 };
const PATH_TARGET = { x: 5, y: 0, z: -2 };

const OFFMESH_CONNECTIONS: OffMeshConnection[] = [
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

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const freeze = new URLSearchParams(window.location.search).get("freeze") === "1";

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(1.8, 1.0, 20, { x: 0, y: 1, z: 0 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const container = await loadGltf(engine, NAV_MESH_URL);
    addToScene(scene, container);
    const staticMesh: Mesh | undefined = scene.meshes.find((m) => m.name === "Cube-Mesh") ?? scene.meshes[0];
    if (!staticMesh) {
        throw new Error("nav_test.glb did not provide a mesh");
    }

    const nav = await createNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
    const maxAgentRadius = 0.15;
    const cellSize = 0.05;
    createNavMesh(nav, [staticMesh], {
        cs: cellSize,
        ch: 0.2,
        walkableRadius: Math.ceil(maxAgentRadius / cellSize),
        offMeshConnections: OFFMESH_CONNECTIONS,
        keepIntermediates: true,
        maxObstacles: 0,
    });

    const debugGeo = createDebugNavMeshGeometry(nav);
    const navDebug = createMeshFromData(engine as never, "navDebug", debugGeo.positions, debugGeo.normals, debugGeo.indices);
    const navDebugMat = createStandardMaterial();
    navDebugMat.diffuseColor = [0.1, 0.2, 1];
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;
    navDebug.position.set(0, 0.01, 0);
    addToScene(scene, navDebug);

    const crowd = createNavCrowd(nav, 1, maxAgentRadius);
    const agentSpawn = getClosestPoint(nav, AGENT_START);
    const agentParams = {
        radius: 0.15,
        height: 0.5,
        maxAcceleration: 4,
        maxSpeed: 1,
        collisionQueryRange: 0.5,
        pathOptimizationRange: 0,
        separationWeight: 1,
    };
    const agentIdx = addAgent(crowd, agentSpawn, agentParams);

    const agentBox = createBox(engine, 1);
    agentBox.scaling.set(agentParams.radius * 2, agentParams.height, agentParams.radius * 2);
    const agentMat = createStandardMaterial();
    agentMat.diffuseColor = [0.7, 0.3, 0.7];
    agentBox.material = agentMat;
    agentBox.position.set(agentSpawn.x, agentSpawn.y + agentParams.height / 2, agentSpawn.z);
    addToScene(scene, agentBox);

    const target = getClosestPoint(nav, PATH_TARGET);
    const pathPoints = computePath(nav, agentSpawn, target);
    if (pathPoints.length < 2) {
        throw new Error(`Lite path computation failed: ${pathPoints.length} points`);
    }
    canvas.dataset.pathLen = String(pathPoints.length);

    const pathDraw = pathPoints.map((p) => ({ x: p.x, y: p.y + 0.2, z: p.z }));
    const pathTube = createTube(engine, { path: pathDraw, radius: 0.04, tessellation: 12 });
    const pathMat = createStandardMaterial();
    pathMat.diffuseColor = [0, 0, 0];
    pathMat.emissiveColor = [1, 0, 0];
    pathTube.material = pathMat;
    addToScene(scene, pathTube);

    if (!freeze) {
        agentGoto(crowd, agentIdx, target);
    }

    let frame = 0;
    onBeforeRender(scene, (deltaMs) => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        if (!freeze) {
            updateNavCrowd(crowd, deltaMs / 1000);
            const p = getAgentPosition(crowd, agentIdx);
            agentBox.position.set(p.x, p.y + agentParams.height / 2, p.z);
        }
        frame++;
        if (frame === 1) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);
}

main().catch(console.error);
