// Scene 171: Navigation crowd with single agent + computed path (port of playground #DPDNVH#2)
//
// First frame: build navmesh from nav_test.glb, place a single crowd agent at
// {-2, 0, 3} (snapped to navmesh) and compute a path to a deterministic
// "random" target. Draw the path with a thin blue tube. Set ready.
//
// With `?freeze=1`: agent never moves after frame 1 — used by parity tests.
// Without it: the agent walks the path interactively.

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
import type { Mesh } from "babylon-lite";

const NAV_MESH_URL = "/models/nav_test.glb";
const AGENT_START = { x: 4, y: 0, z: 5 };
const PATH_TARGET = { x: -3, y: 3, z: -3 };

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const freeze = new URLSearchParams(window.location.search).get("freeze") === "1";

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(1.8, 1.0, 14, { x: 0, y: 0, z: 0 });
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

    // Compute path agent -> target, then visualize it as a thin blue tube.
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

    // Move agent towards target unless frozen.
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
