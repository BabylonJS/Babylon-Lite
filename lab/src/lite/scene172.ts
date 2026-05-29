// Scene 172: Navigation crowd + tile-cache with 2 static obstacles (port of playground #DPDNVH#3)
//
// Tile-cache navmesh on a 10x10 ground with a cylinder obstacle at (1.5, 0, -1.5)
// and a box obstacle at (-2, 1, 1). Single agent at (-3, 0, 3.5) computes a path
// to (3, 0, -3.5), bending around the obstacles. Path drawn as a tube on frame 1.
//
// `?freeze=1`: crowd updates skipped — used by parity tests.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createBox,
    createGround,
    createTube,
    createStandardMaterial,
    createMeshFromData,
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
    addBoxObstacle,
    addCylinderObstacle,
    updateNavMeshObstacles,
} from "babylon-lite";

const AGENT_START = { x: -3, y: 0, z: 3.5 };
const PATH_TARGET = { x: 3, y: 0, z: -3.5 };
const CYL_POS = { x: 1.5, y: 0, z: -1.5 };
const BOX_POS = { x: -2, y: 1, z: 1 };
const BOX_HALF = { x: 1, y: 1, z: 1 };
const BOX_ANGLE = 0.2;

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

    const ground = createGround(engine, { width: 10, height: 10, subdivisions: 2 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    const nav = await createNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
    const maxAgentRadius = 0.15;
    createNavMesh(nav, [ground], {
        cs: 0.1,
        ch: 0.05,
        tileSize: 32,
        maxObstacles: 32,
        keepIntermediates: true,
    });

    // Obstacles
    addCylinderObstacle(nav, CYL_POS, 1, 0.5);
    addBoxObstacle(nav, BOX_POS, BOX_HALF, BOX_ANGLE);
    updateNavMeshObstacles(nav);

    const obstacleMat = createStandardMaterial();
    obstacleMat.diffuseColor = [0, 0, 0];
    obstacleMat.emissiveColor = [0.7, 0.3, 1];

    function addEdgeTube(
        edgeStart: { x: number; y: number; z: number },
        edgeEnd: { x: number; y: number; z: number },
        position: { x: number; y: number; z: number },
        rotationY: number
    ) {
        const tube = createTube(engine, { path: [edgeStart, edgeEnd], radius: 0.02, tessellation: 4 });
        tube.material = obstacleMat;
        tube.position.set(position.x, position.y, position.z);
        tube.rotation.y = rotationY;
        addToScene(scene, tube);
        return tube;
    }

    function addBoxWireframe(half: { x: number; y: number; z: number }, position: { x: number; y: number; z: number }, rotationY: number) {
        const corners = [
            { x: -half.x, y: -half.y, z: -half.z }, { x: half.x, y: -half.y, z: -half.z },
            { x: half.x, y: -half.y, z: half.z }, { x: -half.x, y: -half.y, z: half.z },
            { x: -half.x, y: half.y, z: -half.z }, { x: half.x, y: half.y, z: -half.z },
            { x: half.x, y: half.y, z: half.z }, { x: -half.x, y: half.y, z: half.z },
        ];
        const edgeIdx: [number, number][] = [
            [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
        ];
        const tubes = [];
        for (const [a, b] of edgeIdx) {
            tubes.push(addEdgeTube(corners[a]!, corners[b]!, position, rotationY));
        }
        return tubes;
    }

    function addCylinderWireframe(height: number, radius: number, segments: number, position: { x: number; y: number; z: number }) {
        const h = height / 2;
        for (let i = 0; i < segments; i++) {
            const a1 = (i / segments) * Math.PI * 2;
            const a2 = ((i + 1) / segments) * Math.PI * 2;
            const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
            const x2 = Math.cos(a2) * radius, z2 = Math.sin(a2) * radius;
            addEdgeTube({ x: x1, y: h, z: z1 }, { x: x2, y: h, z: z2 }, position, 0);
            addEdgeTube({ x: x1, y: -h, z: z1 }, { x: x2, y: -h, z: z2 }, position, 0);
        }
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
            addEdgeTube({ x, y: h, z }, { x, y: -h, z }, position, 0);
        }
    }

    addCylinderWireframe(0.5, 1, 12, CYL_POS);
    addBoxWireframe(BOX_HALF, BOX_POS, BOX_ANGLE);

    const debugGeo = createDebugNavMeshGeometry(nav);
    const navDebug = createMeshFromData(engine as never, "navDebug", debugGeo.positions, debugGeo.normals, debugGeo.indices);
    const navDebugMat = createStandardMaterial();
    navDebugMat.diffuseColor = [0.1, 0.2, 1];
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;
    navDebug.position.set(0, 0.02, 0);
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
