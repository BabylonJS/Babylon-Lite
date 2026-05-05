// Scene 111: scene-wide light UBO stress test.
// Three material families, 16 scene lights, mesh-level include sets, and three
// supported shadow generators exercise packed per-mesh light indices.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createPcfDirectionalShadowGenerator,
    createPcfShadowGenerator,
    createPointLight,
    createSceneContext,
    createShadowGenerator,
    createSolidTexture2D,
    createSphere,
    createSpotLight,
    createStandardMaterial,
    parseNodeMaterialFromSnippet,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { LightBase } from "babylon-lite";
import { SCENE65_NME_JSON } from "../shared/scene65-nme.js";

const STD_ID = "scene111-standard-sphere";
const PBR_ID = "scene111-pbr-sphere";
const NME_ID = "scene111-node-sphere";
const STD_PLANE_ID = "scene111-standard-plane";
const PBR_PLANE_ID = "scene111-pbr-plane";
const NME_PLANE_ID = "scene111-node-plane";
const RECEIVER_PLANE_SIZE = { width: 2.8, height: 4.8, subdivisions: 2 };

function restrict(light: LightBase, ids: readonly string[]): void {
    light.includedOnlyMeshIds = new Set(ids);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.025, g: 0.03, b: 0.045, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 12, { x: 0, y: 1.1, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 80;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const stdSphere = createSphere(engine, { segments: 32, diameter: 1.7 });
    stdSphere.id = STD_ID;
    stdSphere.position.set(-3.2, 1.05, 0);
    stdSphere.receiveShadows = true;
    const stdMat = createStandardMaterial();
    stdMat.diffuseColor = [0.95, 0.18, 0.12];
    stdMat.specularColor = [0.55, 0.55, 0.55];
    stdMat.specularPower = 48;
    stdSphere.material = stdMat;

    const pbrSphere = createSphere(engine, { segments: 32, diameter: 1.7 });
    pbrSphere.id = PBR_ID;
    pbrSphere.position.set(0, 1.05, 0);
    pbrSphere.receiveShadows = true;
    pbrSphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.15, 0.55, 1.0, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 1.0, 1.0, 1),
        metallicFactor: 0.25,
        roughnessFactor: 0.35,
        directIntensity: 1.0,
        environmentIntensity: 0.0,
    });

    const nmeSphere = createSphere(engine, { segments: 32, diameter: 1.7 });
    nmeSphere.id = NME_ID;
    nmeSphere.position.set(3.2, 1.05, 0);
    nmeSphere.receiveShadows = true;

    const stdPlane = createGround(engine, RECEIVER_PLANE_SIZE);
    stdPlane.id = STD_PLANE_ID;
    stdPlane.position.set(-3.2, 0, 0);
    stdPlane.receiveShadows = true;
    const stdPlaneMat = createStandardMaterial();
    stdPlaneMat.diffuseColor = [0.34, 0.3, 0.28];
    stdPlaneMat.specularColor = [0.04, 0.04, 0.04];
    stdPlane.material = stdPlaneMat;

    const pbrPlane = createGround(engine, RECEIVER_PLANE_SIZE);
    pbrPlane.id = PBR_PLANE_ID;
    pbrPlane.position.set(0, 0, 0);
    pbrPlane.receiveShadows = true;
    const pbrPlaneMat = createStandardMaterial();
    pbrPlaneMat.diffuseColor = [0.3, 0.32, 0.36];
    pbrPlaneMat.specularColor = [0.04, 0.04, 0.04];
    pbrPlane.material = pbrPlaneMat;

    const nmePlane = createGround(engine, RECEIVER_PLANE_SIZE);
    nmePlane.id = NME_PLANE_ID;
    nmePlane.position.set(3.2, 0, 0);
    nmePlane.receiveShadows = true;
    const nmePlaneMat = createStandardMaterial();
    nmePlaneMat.diffuseColor = [0.32, 0.28, 0.36];
    nmePlaneMat.specularColor = [0.04, 0.04, 0.04];
    nmePlane.material = nmePlaneMat;

    const light0 = createHemisphericLight([0, 1, 0], 0.18);
    light0.diffuseColor = [0.5, 0.7, 1.0];
    light0.groundColor = [0.08, 0.06, 0.05];
    const light1 = createPointLight([-4.5, 3.5, -3.4], 0.55);
    light1.diffuse = [1.0, 0.35, 0.25];
    light1.range = 12;
    const light2 = createSpotLight([0, 4.5, -4.5], [0, -1, 1], Math.PI / 3, 2, 0.45);
    light2.diffuse = [0.45, 0.75, 1.0];
    light2.range = 14;

    const light3 = createDirectionalLight([-0.6, -1, -0.25], 0.65);
    light3.position.set(3.5, 8, 5);
    light3.diffuse = [1.0, 0.85, 0.65];

    const light4 = createSpotLight([-5, 5, 2.5], [1, -1, -0.35], Math.PI / 3.2, 3, 0.45);
    light4.diffuse = [0.6, 1.0, 0.7];
    light4.range = 13;
    const light5 = createHemisphericLight([0.35, 1, 0.2], 0.16);
    light5.diffuseColor = [1.0, 0.75, 0.5];
    light5.groundColor = [0.04, 0.06, 0.09];
    const light6 = createDirectionalLight([0.7, -1, 0.2], 0.22);
    light6.diffuse = [0.8, 0.85, 1.0];
    const light7 = createPointLight([3.5, 3, 4.8], 0.42);
    light7.diffuse = [1.0, 0.4, 0.85];
    light7.range = 10;

    const light8 = createSpotLight([4.8, 6.0, -4.8], [-3.2, -4.95, 4.8], 1.25, 2, 0.75);
    light8.diffuse = [0.65, 0.9, 1.0];
    light8.range = 16;

    const light9 = createPointLight([-2, 3.8, 4.2], 0.45);
    light9.diffuse = [1.0, 0.9, 0.45];
    light9.range = 10;
    const light10 = createDirectionalLight([-0.25, -1, 0.8], 0.25);
    light10.diffuse = [0.55, 1.0, 0.85];
    const light11 = createSpotLight([5.3, 5, -2], [-1, -1, 0.15], Math.PI / 3.4, 2, 0.42);
    light11.diffuse = [0.9, 0.55, 1.0];
    light11.range = 12;
    const light12 = createPointLight([0, 3.1, 0.3], 0.38);
    light12.diffuse = [0.75, 1.0, 0.65];
    light12.range = 8;

    const light13 = createDirectionalLight([0.85, -1, -0.55], 0.58);
    light13.position.set(6, 8, 5);
    light13.diffuse = [0.9, 0.8, 1.0];

    const light14 = createSpotLight([-4.2, 3.6, 4.4], [1, -0.45, -1], Math.PI / 3, 2, 0.35);
    light14.diffuse = [0.4, 0.85, 1.0];
    light14.range = 12;
    const light15 = createDirectionalLight([0, -1, -0.7], 0.2);
    light15.diffuse = [1.0, 0.65, 0.45];

    const lights = [light0, light1, light2, light3, light4, light5, light6, light7, light8, light9, light10, light11, light12, light13, light14, light15] as const;

    const stdSet = [STD_ID, STD_PLANE_ID];
    const pbrSet = [PBR_ID, PBR_PLANE_ID];
    const nmeSet = [NME_ID, NME_PLANE_ID];
    restrict(light0, [...stdSet, ...nmeSet]);
    restrict(light1, [...stdSet, ...pbrSet]);
    restrict(light2, pbrSet);
    restrict(light3, [...stdSet, ...pbrSet]);
    restrict(light4, stdSet);
    restrict(light5, [...pbrSet, ...nmeSet]);
    restrict(light6, stdSet);
    restrict(light7, nmeSet);
    restrict(light8, [...pbrSet, ...nmeSet]);
    restrict(light9, stdSet);
    restrict(light10, pbrSet);
    restrict(light11, nmeSet);
    restrict(light12, [...pbrSet, ...nmeSet]);
    restrict(light13, [...stdSet, ...nmeSet]);
    restrict(light14, pbrSet);
    restrict(light15, nmeSet);

    for (const light of lights) {
        addToScene(scene, light);
    }

    light3.shadowGenerator = createShadowGenerator(engine, light3, [stdSphere, pbrSphere], {
        mapSize: 512,
        depthScale: 40,
        bias: 0.00008,
        blurScale: 2,
        darkness: 0.15,
        frustumEdgeFalloff: 0,
        orthoMinZ: camera.nearPlane,
        orthoMaxZ: camera.farPlane,
    });
    light8.shadowGenerator = createPcfShadowGenerator(engine, light8, [pbrSphere, nmeSphere], {
        mapSize: 512,
        near: camera.nearPlane,
        far: camera.farPlane,
        darkness: 0.1,
    });
    light13.shadowGenerator = createPcfDirectionalShadowGenerator(engine, light13, [stdSphere, nmeSphere], {
        mapSize: 512,
        orthoMinZ: camera.nearPlane,
        orthoMaxZ: camera.farPlane,
        darkness: 0.12,
    });

    nmeSphere.material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE65_NME_JSON,
        shadowGenerators: [light3.shadowGenerator, light8.shadowGenerator, light13.shadowGenerator],
        shadowLightIndices: [3, 8, 13],
    });

    addToScene(scene, stdPlane);
    addToScene(scene, pbrPlane);
    addToScene(scene, nmePlane);
    addToScene(scene, stdSphere);
    addToScene(scene, pbrSphere);
    addToScene(scene, nmeSphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
