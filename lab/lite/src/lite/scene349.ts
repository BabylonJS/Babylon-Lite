import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    loadTexture2D,
    markMaterialUboDirty,
    onBeforeRender,
    registerScene,
    rebuildMaterial,
    resizeEngine,
    setCameraLimits,
    setPbrGammaAlbedo,
    setPbrParallaxOcclusion,
    setStandardBumpTexture,
    setStandardParallaxOcclusion,
    startEngine,
} from "babylon-lite";
import type { PbrMaterialProps, StandardMaterialProps } from "babylon-lite";
import {
    readScene349Settings,
    SCENE349_CAMERAS,
    SCENE349_ASSETS,
    SCENE349_CLEAR_COLOR,
    SCENE349_LIGHT_DIRECTION,
    SCENE349_PANEL_SIZE,
    SCENE349_PANELS,
    SCENE349_QUALITY,
} from "../shared/scene349-parallax.js";
import type { Scene349Settings } from "../shared/scene349-parallax.js";
import { installScene349CameraSync, installScene349LiveUpdates, reportScene349Error } from "../shared/scene349-parallax-ui.js";

async function main(): Promise<void> {
    const settings = readScene349Settings(location.search);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const [r, g, b, a] = SCENE349_CLEAR_COLOR;
    scene.clearColor = { r, g, b, a };
    const pose = SCENE349_CAMERAS[settings.view];
    const camera = createArcRotateCamera(pose.alpha, pose.beta, pose.radius, { x: 0, y: 0, z: 0 });
    camera.fov = 0.8;
    camera.nearPlane = 0.1;
    camera.farPlane = 50;
    camera.inertia = 0;
    scene.camera = camera;
    setCameraLimits(camera, {
        lowerAlphaLimit: -Math.PI + 0.15,
        upperAlphaLimit: -0.15,
        lowerBetaLimit: 0.35,
        upperBetaLimit: Math.PI - 0.35,
        lowerRadiusLimit: 5.5,
        upperRadiusLimit: 25,
    });
    attachControl(camera, canvas, scene, { shouldHandlePointerDown: (event) => event.button === 0 });
    onBeforeRender(scene, installScene349CameraSync(camera, canvas));

    addToScene(scene, createDirectionalLight([...SCENE349_LIGHT_DIRECTION], 0.85));
    const fill = createHemisphericLight([0, 0.5, -1], 0.25);
    fill.diffuseColor = [0.65, 0.7, 0.8];
    fill.groundColor = [0, 0, 0];
    addToScene(scene, fill);

    const loadTextures = (asset: Scene349Settings["asset"]) => {
        const urls = SCENE349_ASSETS[asset];
        return Promise.all([loadTexture2D(engine, urls.color, { srgb: false }), loadTexture2D(engine, urls.normalHeight, { srgb: false, premultiplyAlpha: false })]);
    };
    let [color, normalHeight] = await loadTextures(settings.asset);
    const parallaxFor = (next: Scene349Settings) => ({
        heightTexture: normalHeight,
        heightChannel: "a" as const,
        heightScale: SCENE349_PANEL_SIZE * next.depth,
        heightCenter: 0,
        ...SCENE349_QUALITY[next.quality],
    });
    const standardMaterials: { material: StandardMaterialProps; pom: boolean }[] = [];
    const pbrMaterials: { material: PbrMaterialProps; pom: boolean }[] = [];
    for (const panel of SCENE349_PANELS) {
        const mesh = createPlane(engine, { width: SCENE349_PANEL_SIZE, height: SCENE349_PANEL_SIZE });
        mesh.name = panel.name;
        mesh.position.set(panel.x, panel.y, 0);
        if (panel.family === "standard") {
            const material = createStandardMaterial();
            material.diffuseColor = [1, 1, 1];
            material.specularColor = [0.08, 0.08, 0.08];
            material.specularPower = 32;
            material.diffuseTexture = color;
            setStandardBumpTexture(material, normalHeight);
            if (settings.pom && panel.pom) {
                setStandardParallaxOcclusion(material, parallaxFor(settings));
            }
            standardMaterials.push({ material, pom: panel.pom });
            mesh.material = material;
        } else {
            const material = createPbrMaterial({
                baseColorTexture: color,
                normalTexture: normalHeight,
                metallicFactor: 0,
                roughnessFactor: 0.65,
                environmentIntensity: 0,
                occlusionStrength: 0,
            });
            setPbrGammaAlbedo(material);
            if (settings.pom && panel.pom) {
                setPbrParallaxOcclusion(material, parallaxFor(settings));
            }
            pbrMaterials.push({ material, pom: panel.pom });
            mesh.material = material;
        }
        addToScene(scene, mesh);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.implementation = "lite";
    canvas.dataset.heightScale = String(SCENE349_PANEL_SIZE * settings.depth);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    installScene349LiveUpdates(settings, canvas, async (next, previous) => {
        const texturesChanged = next.asset !== previous.asset;
        if (texturesChanged) {
            [color, normalHeight] = await loadTextures(next.asset);
        }
        const paramsChanged = next.depth !== previous.depth || next.quality !== previous.quality || next.pom !== previous.pom;
        const featureChanged = (next.pom && next.depth > 0) !== (previous.pom && previous.depth > 0);
        for (const entry of standardMaterials) {
            if (texturesChanged) {
                entry.material.diffuseTexture = color;
                setStandardBumpTexture(entry.material, normalHeight);
            }
            if (entry.pom && (paramsChanged || texturesChanged)) {
                setStandardParallaxOcclusion(entry.material, next.pom ? parallaxFor(next) : null);
            }
            if (texturesChanged || (entry.pom && paramsChanged)) {
                const completion = rebuildMaterial(scene, entry.material);
                if (completion) {
                    await completion;
                }
            }
        }
        for (const entry of pbrMaterials) {
            if (texturesChanged) {
                entry.material.baseColorTexture = color;
                entry.material.normalTexture = normalHeight;
            }
            if (entry.pom && (paramsChanged || texturesChanged)) {
                setPbrParallaxOcclusion(entry.material, next.pom ? parallaxFor(next) : null);
            }
            if (texturesChanged || (entry.pom && featureChanged)) {
                const completion = rebuildMaterial(scene, entry.material);
                if (completion) {
                    await completion;
                }
            } else if (entry.pom && paramsChanged && next.pom && next.depth > 0) {
                markMaterialUboDirty(entry.material);
            }
        }
        if (next.view !== previous.view) {
            const nextPose = SCENE349_CAMERAS[next.view];
            camera.alpha = nextPose.alpha;
            camera.beta = nextPose.beta;
            camera.radius = nextPose.radius;
        }
        canvas.dataset.heightScale = String(SCENE349_PANEL_SIZE * next.depth);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    resizeEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(reportScene349Error);
