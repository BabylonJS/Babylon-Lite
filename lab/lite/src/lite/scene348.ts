import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createPcfDirectionalShadowGenerator,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    registerSceneWithShadowSupport,
    setAlphaToCoverage,
    setMeshOpacity,
    setPbrAlphaCutoff,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import type { Material, Mesh, StandardMaterialProps } from "babylon-lite";
import { createOpacityMaskPixels, MASK_HEIGHT, MASK_WIDTH, OPACITY_COLUMNS, OPACITY_ROWS, SHADOW_SAMPLES, waitOpacityFrames } from "../shared/scene348-opacity.js";

function standardMaterial(color: readonly [number, number, number]): StandardMaterialProps {
    const material = createStandardMaterial();
    material.diffuseColor = [...color];
    material.specularColor = [0, 0, 0];
    return material;
}

/** Direct Standard/PBR parity plus explicitly normalized OPAQUE/MASK, shadow and A2C policies. */
async function main(): Promise<void> {
    const capture = new URLSearchParams(location.search).has("capture");
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.08, g: 0.1, b: 0.14, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 17, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 60;
    scene.camera = camera;

    const hemi = createHemisphericLight([0, 1, 0], 0.65);
    addToScene(scene, hemi);
    const light = createDirectionalLight([0.4, -1, 0.7], 0.8);
    light.position.set(-4, 10, -7);
    light.specular = [0, 0, 0];
    addToScene(scene, light);

    const mask = createTexture2DFromPixels(engine, createOpacityMaskPixels(), MASK_WIDTH, MASK_HEIGHT, {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    const shared = new Map<string, Material>();

    // Region (a): programmatic Standard/PBR without explicit BJS transparency modes.
    // Region (b): loader-shaped OPAQUE/MASK, whose deliberate fading uses a NORMALIZED BJS oracle.
    for (const row of OPACITY_ROWS) {
        const material =
            row.family === "standard"
                ? standardMaterial(row.color)
                : createPbrMaterial({
                      baseColorFactor: [...row.color, 1],
                      metallicFactor: 0,
                      roughnessFactor: 0.82,
                      ...(row.name.startsWith("normalized") ? { alphaBlend: false } : {}),
                      ...(row.name === "normalized-mask" ? { baseColorTexture: mask, alpha: 1 } : {}),
                  });
        if (row.name === "normalized-mask") {
            setPbrAlphaCutoff(material, 0.5);
        }
        shared.set(row.name, material);
        for (const column of OPACITY_COLUMNS) {
            const mesh = createPlane(engine, { width: 2.2, height: 1.3 });
            mesh.name = `${row.name}-${column.opacity}-${column.x}`;
            mesh.position.set(column.x, row.y, 0);
            mesh.material = material;
            setMeshOpacity(mesh, column.opacity);
            addToScene(scene, mesh);
        }
    }

    const ground = createGround(engine, { width: 14, height: 7 });
    ground.name = "policy-shadow-receiver";
    ground.position.set(0, -4.2, 1.5);
    ground.material = standardMaterial([0.55, 0.58, 0.62]);
    ground.receiveShadows = true;
    addToScene(scene, ground);

    const casters: Mesh[] = [];
    for (const sample of SHADOW_SAMPLES) {
        const mesh = createBox(engine, 1.1);
        mesh.name = sample.name;
        mesh.position.set(sample.x, -3.55, 0);
        mesh.material = shared.get(sample.family === "standard" ? "direct-standard" : "direct-pbr")!;
        setMeshOpacity(mesh, sample.opacity);
        addToScene(scene, mesh);
        casters.push(mesh);
    }
    const shadows = createPcfDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        orthoMinZ: 0.1,
        orthoMaxZ: 40,
        forceRefreshEveryFrame: capture,
    });
    setShadowTaskCasterMeshes(shadows, casters);
    light.shadowGenerator = shadows;

    // Lite policy sample: final opacity drives both blending and A2C.
    const a2cMaterial = standardMaterial([0.7, 0.25, 0.85]);
    setAlphaToCoverage(a2cMaterial, true);
    const a2c = createPlane(engine, { width: 1.1, height: 2.4 });
    a2c.name = "policy-a2c-half";
    a2c.position.set(6.4, 1.1, 0);
    a2c.material = a2cMaterial;
    setMeshOpacity(a2c, 0.5);
    addToScene(scene, a2c);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    await waitOpacityFrames(8);
    canvas.dataset.opacityMode = "feature";
    canvas.dataset.oracleRegions = "direct-standard-pbr,normalized-opaque-mask,normalized-shadow-a2c-policy";
    canvas.dataset.sampleCount = String(engine.msaaSamples);
    canvas.dataset.shadowRefresh = capture ? "every-frame" : "on-change";
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
