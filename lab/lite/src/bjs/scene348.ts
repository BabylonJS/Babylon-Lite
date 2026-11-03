import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
    readScene348Settings,
    SCENE348_CAMERAS,
    SCENE348_ASSETS,
    SCENE348_CLEAR_COLOR,
    SCENE348_LIGHT_DIRECTION,
    SCENE348_PANEL_SIZE,
    SCENE348_PANELS,
} from "../shared/scene348-parallax.js";
import type { Scene348Settings } from "../shared/scene348-parallax.js";
import { installScene348CameraSync, installScene348LiveUpdates, reportScene348Error } from "../shared/scene348-parallax-ui.js";

async function main(): Promise<void> {
    const settings = readScene348Settings(location.search);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    scene.clearColor = new Color4(...SCENE348_CLEAR_COLOR);
    const pose = SCENE348_CAMERAS[settings.view];
    const camera = new ArcRotateCamera("camera", pose.alpha, pose.beta, pose.radius, Vector3.Zero(), scene);
    camera.fov = 0.8;
    camera.minZ = 0.1;
    camera.maxZ = 50;
    camera.inertia = 0;
    camera.panningSensibility = 0;
    camera.lowerAlphaLimit = -Math.PI + 0.15;
    camera.upperAlphaLimit = -0.15;
    camera.lowerBetaLimit = 0.35;
    camera.upperBetaLimit = Math.PI - 0.35;
    camera.lowerRadiusLimit = 5.5;
    camera.upperRadiusLimit = 25;
    camera.attachControl(canvas, true);
    scene.onBeforeRenderObservable.add(installScene348CameraSync(camera, canvas));
    const key = new DirectionalLight("key", new Vector3(...SCENE348_LIGHT_DIRECTION), scene);
    key.intensity = 0.85;
    const fill = new HemisphericLight("fill", new Vector3(0, 0.5, -1), scene);
    fill.intensity = 0.25;
    fill.diffuse = new Color3(0.65, 0.7, 0.8);
    fill.groundColor = Color3.Black();

    const loadTexture = (url: string, gammaSpace: boolean): Promise<Texture> =>
        new Promise((resolve, reject) => {
            const texture = new Texture(
                url,
                scene,
                false,
                true,
                Texture.TRILINEAR_SAMPLINGMODE,
                () => resolve(texture),
                (message, cause) => reject(new Error(`Scene 348 failed to load ${url}: ${message ?? "texture loading error"}`, { cause }))
            );
            texture.wrapU = Texture.WRAP_ADDRESSMODE;
            texture.wrapV = Texture.WRAP_ADDRESSMODE;
            texture.gammaSpace = gammaSpace;
            texture.anisotropicFilteringLevel = 4;
        });
    const textures: Partial<Record<Scene348Settings["asset"], Promise<[Texture, Texture]>>> = {};
    const loadTextures = (asset: Scene348Settings["asset"]): Promise<[Texture, Texture]> => {
        let pair = textures[asset];
        if (!pair) {
            const urls = SCENE348_ASSETS[asset];
            pair = Promise.all([loadTexture(urls.color, true), loadTexture(urls.normalHeight, false)]);
            textures[asset] = pair;
            void pair.catch(() => {
                delete textures[asset];
            });
        }
        return pair;
    };
    let [color, normalHeight] = await loadTextures(settings.asset);
    const materials: { material: StandardMaterial | PBRMaterial; pom: boolean }[] = [];
    for (const panel of SCENE348_PANELS) {
        const mesh = MeshBuilder.CreatePlane(panel.name, { size: SCENE348_PANEL_SIZE }, scene);
        mesh.position.set(panel.x, panel.y, 0);
        const material = panel.family === "standard" ? new StandardMaterial(panel.name, scene) : new PBRMaterial(panel.name, scene);
        material.bumpTexture = normalHeight;
        material.useParallax = settings.pom && panel.pom;
        material.useParallaxOcclusion = settings.pom && panel.pom;
        material.parallaxScaleBias = settings.depth;
        if (material instanceof StandardMaterial) {
            material.diffuseColor = Color3.White();
            material.diffuseTexture = color;
            material.specularColor = new Color3(0.08, 0.08, 0.08);
            material.specularPower = 32;
        } else {
            material.albedoTexture = color;
            material.metallic = 0;
            material.roughness = 0.65;
            material.environmentIntensity = 0;
        }
        materials.push({ material, pom: panel.pom });
        mesh.material = material;
    }
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    window.addEventListener("resize", () => engine.resize());
    canvas.dataset.implementation = "babylon";
    canvas.dataset.parallaxScaleBias = String(settings.depth);
    canvas.dataset.drawCalls = String(scene.meshes.length);
    installScene348LiveUpdates(settings, canvas, async (next, previous) => {
        const texturesChanged = next.asset !== previous.asset;
        if (texturesChanged) {
            [color, normalHeight] = await loadTextures(next.asset);
        }
        for (const entry of materials) {
            if (texturesChanged) {
                entry.material.bumpTexture = normalHeight;
                if (entry.material instanceof StandardMaterial) {
                    entry.material.diffuseTexture = color;
                } else {
                    entry.material.albedoTexture = color;
                }
            }
            entry.material.useParallax = next.pom && entry.pom;
            entry.material.useParallaxOcclusion = next.pom && entry.pom;
            entry.material.parallaxScaleBias = next.depth;
        }
        if (next.view !== previous.view) {
            const nextPose = SCENE348_CAMERAS[next.view];
            camera.alpha = nextPose.alpha;
            camera.beta = nextPose.beta;
            camera.radius = nextPose.radius;
        }
        if (texturesChanged || next.pom !== previous.pom) {
            await scene.whenReadyAsync();
        }
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
        canvas.dataset.parallaxScaleBias = String(next.depth);
    });
    engine.resize();
    canvas.dataset.ready = "true";
}

main().catch(reportScene348Error);
