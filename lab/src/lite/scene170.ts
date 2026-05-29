// Scene 170: Navigation initialization — Recast V2 navmesh + crowd agent (matches playground #KVQP83#0)

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createFreeCamera,
    createHemisphericLight,
    createSphere,
    createBox,
    createGround,
    createStandardMaterial,
    createMeshFromData,
    onBeforeRender,
    registerScene,
    createNavigationPluginAsync,
    createNavMesh,
    createDebugNavMeshGeometry,
    getClosestPoint,
    createNavCrowd,
    addAgent,
    getAgentPosition,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createFreeCamera({ x: -6, y: 4, z: -8 }, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const ground = createGround(engine, { width: 6, height: 6, subdivisions: 2 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    const sphere = createSphere(engine, { diameter: 2, segments: 16 });
    sphere.material = createStandardMaterial();
    sphere.position.set(0, 1, 0);
    addToScene(scene, sphere);

    const box = createBox(engine, 1);
    box.material = createStandardMaterial();
    box.scaling.set(1, 3, 1);
    box.position.set(1, 1.5, 0);
    addToScene(scene, box);

    const nav = await createNavigationPluginAsync({ locateFile: () => "/recast-navigation.wasm" });
    createNavMesh(nav, [ground, sphere, box], {
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
    });

    const debugGeo = createDebugNavMeshGeometry(nav);
    const navDebug = createMeshFromData(engine as never, "navDebug", debugGeo.positions, debugGeo.normals, debugGeo.indices);
    const navDebugMat = createStandardMaterial();
    navDebugMat.diffuseColor = [0.1, 0.2, 1];
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;
    navDebug.position.set(0, 0.01, 0);
    addToScene(scene, navDebug);

    const crowd = createNavCrowd(nav, 10, 0.1);
    const agentSpawn = getClosestPoint(nav, { x: -2.0, y: 0.1, z: -1.8 });
    const agentBox = createBox(engine, 0.2);
    const agentMat = createStandardMaterial();
    agentMat.diffuseColor = [0.7, 0.3, 0.7];
    agentBox.material = agentMat;
    agentBox.position.set(agentSpawn.x, agentSpawn.y, agentSpawn.z);
    addToScene(scene, agentBox);

    const agentIdx = addAgent(crowd, agentSpawn, {
        radius: 0.1,
        height: 0.2,
        maxAcceleration: 4,
        maxSpeed: 1,
        collisionQueryRange: 0.5,
        pathOptimizationRange: 0,
        separationWeight: 1,
    });

    let frame = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        const p = getAgentPosition(crowd, agentIdx);
        agentBox.position.set(p.x, p.y, p.z);
        frame++;
        if (frame === 3) {
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);
}

main().catch(console.error);
