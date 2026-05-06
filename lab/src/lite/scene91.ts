// Scene 91: CSG2 operations — adapted from Babylon playground #0MDAYA.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createCsg2FromMesh,
    createEngine,
    createHemisphericLight,
    createMeshesFromCsg2,
    createPlane,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    csg2Add,
    csg2Intersect,
    csg2Subtract,
    disposeCsg2,
    initializeCsg2Async,
    loadTexture2D,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { Csg2Solid, EngineContext, Mesh, StandardMaterialProps } from "babylon-lite";

const GRASS_URL = "https://playground.babylonjs.com/textures/grass.png";
const CRATE_URL = "https://playground.babylonjs.com/textures/crate.png";

function labelTextureUrl(text: string): string {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Scene 91 labels require a 2D canvas context.");
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "black";
    ctx.font = "700 64px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 128, 78);
    return canvas.toDataURL("image/png");
}

async function createLabelMaterial(engine: EngineContext, text: string): Promise<StandardMaterialProps> {
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.emissiveColor = [1, 1, 1];
    material.diffuseTexture = await loadTexture2D(engine, labelTextureUrl(text), {
        mipMaps: false,
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    material.alphaCutOff = 0.5;
    material.backFaceCulling = false;
    return material;
}

function setMeshPosition(mesh: Mesh, x: number, y: number, z = 0): void {
    mesh.position.x = x;
    mesh.position.y = y;
    mesh.position.z = z;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    await initializeCsg2Async();
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-1.5, 1.6, 18, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1));

    const [grassTexture, crateTexture, subtractLabel, intersectLabel, unionLabel, equalsLabel] = await Promise.all([
        loadTexture2D(engine, GRASS_URL, { invertY: true }),
        loadTexture2D(engine, CRATE_URL, { invertY: true }),
        createLabelMaterial(engine, "-"),
        createLabelMaterial(engine, "∩"),
        createLabelMaterial(engine, "+"),
        createLabelMaterial(engine, "="),
    ]);

    const crateMaterial = createStandardMaterial();
    crateMaterial.diffuseTexture = crateTexture;
    const grassMaterial = createStandardMaterial();
    grassMaterial.diffuseTexture = grassTexture;

    const rows: Array<{ y: number; label: StandardMaterialProps; op: "subtract" | "intersect" | "union" }> = [
        { y: -4, label: subtractLabel, op: "subtract" },
        { y: 0, label: intersectLabel, op: "intersect" },
        { y: 4, label: unionLabel, op: "union" },
    ];

    for (const row of rows) {
        const box = createBox(engine, 2);
        const sphere = createSphere(engine, { diameter: 2.5, segments: 32 });
        box.material = crateMaterial;
        sphere.material = grassMaterial;
        const boxCsg = createCsg2FromMesh(box, 0);
        const sphereCsg = createCsg2FromMesh(sphere, 1);
        let resultCsg: Csg2Solid | undefined;
        let resultMeshes: Mesh[] = [];
        try {
            resultCsg = row.op === "subtract" ? csg2Subtract(boxCsg, sphereCsg) : row.op === "intersect" ? csg2Intersect(boxCsg, sphereCsg) : csg2Add(boxCsg, sphereCsg);
            resultMeshes = createMeshesFromCsg2(engine, resultCsg, [crateMaterial, grassMaterial], `csg-${row.op}`);
        } finally {
            disposeCsg2(boxCsg);
            disposeCsg2(sphereCsg);
            if (resultCsg) {
                disposeCsg2(resultCsg);
            }
        }

        setMeshPosition(box, -4, row.y);
        setMeshPosition(sphere, 0.2, row.y);
        addToScene(scene, box);
        addToScene(scene, sphere);
        for (const result of resultMeshes) {
            setMeshPosition(result, 4, row.y);
            addToScene(scene, result);
        }

        const label = createPlane(engine, { width: 1.4, height: 0.7 });
        label.material = row.label;
        setMeshPosition(label, -2, row.y);
        addToScene(scene, label);

        const equals = createPlane(engine, { width: 1.4, height: 0.7 });
        equals.material = equalsLabel;
        setMeshPosition(equals, 2, row.y);
        addToScene(scene, equals);
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
