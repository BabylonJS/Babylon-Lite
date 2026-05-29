// Scene 175: Navigation raycast (port of playground #DPDNVH#7).
//
// No crowd or agents — just nav_test.glb + a raycast between a fixed start and
// end point. Three sphere markers (start = blue, end = green, hit = red) and a
// yellow tube traces the raycast result (start → hitPoint if hit, else end).
//
// Start and end are well-separated so the raycast crosses a large portion of
// the navmesh.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createSphere,
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
    raycast,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const NAV_MESH_URL = "/models/nav_test.glb";
const Y_OFFSET = 0.1;
const RAY_START = { x: -5, y: Y_OFFSET, z: 1.5 };
const RAY_END = { x: 5, y: Y_OFFSET, z: -3 };

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

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

    function makeMarker(name: string, color: [number, number, number], position: { x: number; y: number; z: number }) {
        const sphere = createSphere(engine, { diameter: 0.25 });
        const mat = createStandardMaterial();
        mat.diffuseColor = [0, 0, 0];
        mat.emissiveColor = color;
        sphere.material = mat;
        sphere.position.set(position.x, position.y, position.z);
        sphere.name = name;
        addToScene(scene, sphere);
        return sphere;
    }

    const RAISE = 0.2;
    makeMarker("start", [0, 0, 1], { x: RAY_START.x, y: RAY_START.y + RAISE, z: RAY_START.z });
    makeMarker("end", [0, 1, 0], { x: RAY_END.x, y: RAY_END.y + RAISE, z: RAY_END.z });

    const result = raycast(nav, RAY_START, RAY_END);
    const lineEnd = result.hit && result.hitPoint ? result.hitPoint : RAY_END;
    if (result.hit && result.hitPoint) {
        makeMarker("hit", [1, 0, 0], { x: result.hitPoint.x, y: result.hitPoint.y + RAISE, z: result.hitPoint.z });
    }
    canvas.dataset.rayHit = String(result.hit);

    const rayPath = [
        { x: RAY_START.x, y: RAY_START.y + RAISE, z: RAY_START.z },
        { x: lineEnd.x, y: lineEnd.y + RAISE, z: lineEnd.z },
    ];
    const rayTube = createTube(engine, { path: rayPath, radius: 0.04, tessellation: 12 });
    const rayMat = createStandardMaterial();
    rayMat.diffuseColor = [0, 0, 0];
    rayMat.emissiveColor = [1, 0, 0];
    rayTube.material = rayMat;
    addToScene(scene, rayTube);

    let frame = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
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
