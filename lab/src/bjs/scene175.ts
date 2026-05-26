// Scene 175: Navigation raycast (port of playground #DPDNVH#7).

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
const Y_OFFSET = 0.1;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
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
        keepIntermediates: true,
        maxObstacles: 0,
    } as never);

    const navDebug = nav.createDebugNavMesh(scene);
    navDebug.position.y = 0.01;
    const navDebugMat = new StandardMaterial("navDebug", scene);
    navDebugMat.diffuseColor = new Color3(0.1, 0.2, 1);
    navDebugMat.alpha = 0.2;
    navDebug.material = navDebugMat;

    function makeMarker(name: string, color: Color3, pos: Vector3) {
        const sphere = MeshBuilder.CreateSphere(name, { diameter: 0.25 }, scene);
        const mat = new StandardMaterial(name + "Mat", scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = color;
        sphere.material = mat;
        sphere.position = pos;
        return sphere;
    }

    const start = new Vector3(-5, Y_OFFSET, 1.5);
    const end = new Vector3(5, Y_OFFSET, -3);
    const RAISE = 0.2;
    const startRaised = new Vector3(start.x, start.y + RAISE, start.z);
    const endRaised = new Vector3(end.x, end.y + RAISE, end.z);
    makeMarker("start", new Color3(0, 0, 1), startRaised);
    makeMarker("end", new Color3(0, 1, 0), endRaised);

    const rayResult = nav.raycast(start, end);
    const lineEnd: Vector3 = rayResult.hit && rayResult.hitPoint ? rayResult.hitPoint : end;
    const lineEndRaised = new Vector3(lineEnd.x, lineEnd.y + RAISE, lineEnd.z);
    if (rayResult.hit && rayResult.hitPoint) {
        makeMarker("hit", new Color3(1, 0, 0), new Vector3(rayResult.hitPoint.x, rayResult.hitPoint.y + RAISE, rayResult.hitPoint.z));
    }
    canvas.dataset.rayHit = String(rayResult.hit);

    const rayPath: Vector3[] = [startRaised, lineEndRaised];
    const rayTube = MeshBuilder.CreateTube("rayTube", { path: rayPath, radius: 0.04, tessellation: 12 }, scene);
    const rayMat = new StandardMaterial("rayMat", scene);
    rayMat.diffuseColor = new Color3(0, 0, 0);
    rayMat.emissiveColor = new Color3(1, 0, 0);
    rayTube.material = rayMat;

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
