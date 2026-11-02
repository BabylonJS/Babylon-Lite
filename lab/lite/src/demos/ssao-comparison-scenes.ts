import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createPointLight,
    createSphere,
    getContainerMeshes,
    loadGltf,
    pauseAnimation,
    playAnimation,
    goToFrame,
    setMeshVisible,
} from "babylon-lite";
import type { AnimationGroup, ArcRotateCamera, EngineContext, Mesh, SceneContext } from "babylon-lite";
import type { ComparisonScene } from "../shared/ssao-comparison-contract.js";
import { createAoDeformationExamples } from "./ambient-occlusion-deformation.js";
import { demoAssetUrl } from "./demo-asset-url.js";
import { createKitchenScene, KITCHEN_CAMERA } from "../shared/kitchen-scene.js";

export interface ComparisonSceneState {
    camera: ArcRotateCamera;
    preset: { alpha: number; beta: number; radius: number; x: number; y: number; z: number };
    sphere: Mesh | null;
    animations: AnimationGroup[];
}

export async function createComparisonScene(engine: EngineContext, scene: SceneContext, id: ComparisonScene): Promise<ComparisonSceneState> {
    if (id === "kitchen") {
        const camera = await createKitchenScene(engine, scene, demoAssetUrl("./ssao-comparison/kitchen.glb", import.meta.url));
        return { camera, preset: { ...KITCHEN_CAMERA }, sphere: null, animations: [] };
    }
    const preset =
        id === "cornell"
            ? { alpha: Math.PI / 2, beta: 1.35, radius: 5.3, x: 0, y: 1.2, z: 0 }
            : { alpha: -Math.PI / 2.7, beta: 1.08, radius: id === "layers" ? 7.4 : 8.5, x: 0, y: 0.9, z: 0 };
    const camera = createArcRotateCamera(preset.alpha, preset.beta, preset.radius, { x: preset.x, y: preset.y, z: preset.z });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    scene.camera = camera;
    const state: ComparisonSceneState = { camera, preset, sphere: null, animations: [] };
    addToScene(scene, createHemisphericLight([0, 1, 0], id === "cornell" ? 0.12 : 0.5));
    addToScene(scene, createDirectionalLight([0.3, -1, 0.45], id === "cornell" ? 0.3 : 1.1));
    if (id === "cornell") {
        addToScene(scene, createPointLight([0, 2.9, 0], 1.6));
        const asset = await loadGltf(engine, demoAssetUrl("./screen-space-effects/cornellBox.glb", import.meta.url));
        const background = getContainerMeshes(asset).find((mesh) => mesh.name === "BackgroundPlane");
        if (background) {
            setMeshVisible(background, false);
        }
        addToScene(scene, asset);
        return state;
    }
    const material = (color: [number, number, number]) => {
        const result = createPbrMaterial();
        result.baseColorFactor = [...color, 1];
        result.metallicFactor = 0;
        result.roughnessFactor = 0.9;
        return result;
    };
    const gray = material([0.65, 0.65, 0.65]),
        blue = material([0.1, 0.3, 0.6]),
        orange = material([0.65, 0.22, 0.065]);
    const ground = createGround(engine, { width: 8, height: 6 });
    ground.material = gray;
    addToScene(scene, ground);
    const box = (position: [number, number, number], size: [number, number, number], color = gray) => {
        const mesh = createBox(engine);
        mesh.position.x = position[0];
        mesh.position.y = position[1];
        mesh.position.z = position[2];
        mesh.scaling.x = size[0];
        mesh.scaling.y = size[1];
        mesh.scaling.z = size[2];
        mesh.material = color;
        addToScene(scene, mesh);
        return mesh;
    };
    box([0, 1.5, 2.6], [8, 3, 0.12]);
    box([-3.8, 1.5, 0], [0.12, 3, 5.2]);
    if (id === "layers") {
        for (let i = 0; i < 10; i++) {
            box([-2.4 + i * 0.34, 0.5, 0.8], [0.055, 1, 1], i % 2 ? orange : blue);
        }
        for (let i = 0; i < 4; i++) {
            box([1.7, 0.2 + i * 0.26, 0.3], [1.5, 0.045, 1.6], i % 2 ? orange : gray);
        }
        const panel = box([-0.7, 0.8, -1.2], [2.4, 1.6, 0.055], blue);
        panel.rotation.y = 0.35;
        box([0.7, 0.35, -1.55], [0.8, 0.7, 0.8], orange);
    } else {
        box([-1.2, 0.6, 0.8], [1.2, 1.2, 1.2], blue);
        box([-1.2, 1.6, 0.8], [0.8, 0.8, 0.8], orange);
        box([1.3, 0.6, 1.85], [1.7, 1.2, 0.12], orange);
        const sphere = createSphere(engine, { diameter: 1.5, segments: 32 });
        sphere.position.x = 1.3;
        sphere.position.y = 0.75;
        sphere.position.z = -0.2;
        sphere.material = blue;
        addToScene(scene, sphere);
        if (id === "motion") {
            state.sphere = sphere;
            const asset = await createAoDeformationExamples(engine);
            addToScene(scene, asset);
            state.animations = [...(asset.animationGroups ?? [])];
            if (!state.animations.length) {
                throw new Error("Comparison deformation animations did not load.");
            }
        } else {
            box([2.5, 0.25, -0.8], [0.6, 0.5, 0.6], orange);
            box([2.5, 0.82, -0.8], [0.6, 0.5, 0.6], gray);
        }
    }
    return state;
}

export function setComparisonAnimation(state: ComparisonSceneState, enabled: boolean): void {
    for (const group of state.animations) {
        group.loopAnimation = true;
        if (enabled) {
            playAnimation(group);
        } else {
            pauseAnimation(group);
        }
    }
}

export function resetComparisonScene(state: ComparisonSceneState): void {
    const { camera, preset } = state;
    camera.alpha = preset.alpha;
    camera.beta = preset.beta;
    camera.radius = preset.radius;
    camera.target.x = preset.x;
    camera.target.y = preset.y;
    camera.target.z = preset.z;
    camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = camera.inertialPanningY = 0;
    if (state.sphere) {
        state.sphere.position.x = 1.3;
    }
    for (const group of state.animations) {
        goToFrame(group, 0);
    }
}
