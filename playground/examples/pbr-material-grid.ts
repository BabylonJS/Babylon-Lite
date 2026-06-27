/**
 * PBR Material Grid — the classic metalness × roughness sweep. A 6×6 grid of
 * spheres where metalness increases up each column and roughness increases across
 * each row, all lit purely by an image-based environment (IBL). The camera slowly
 * auto-orbits so you can watch the reflections move. A great way to get a feel for
 * how the two core PBR parameters interact. Uses only public Babylon.js assets.
 */
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSphere,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const GRID = 6;
const SPACING = 1.35;

// A warm copper base colour so the dielectric → metal transition reads clearly.
const BASE: [number, number, number] = [0.95, 0.64, 0.54];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const span = (GRID - 1) * SPACING;
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.2, span * 1.9, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    // Image-based lighting + a matching blurred skybox for reflections.
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });

    for (let row = 0; row < GRID; row++) {
        const metallic = row / (GRID - 1);
        for (let col = 0; col < GRID; col++) {
            // Clamp roughness away from 0 so the smoothest spheres still resolve.
            const roughness = Math.max(0.04, col / (GRID - 1));

            const sphere = createSphere(engine, { diameter: 1, segments: 32 });
            sphere.position.set((col - (GRID - 1) / 2) * SPACING, (row - (GRID - 1) / 2) * SPACING, 0);
            // No per-sphere textures: factors multiply the shared 1×1 white fallback,
            // so all 36 materials reuse the same GPU textures (no allocations in the loop).
            sphere.material = createPbrMaterial({
                baseColorFactor: [BASE[0], BASE[1], BASE[2], 1],
                metallicFactor: metallic,
                roughnessFactor: roughness,
                environmentIntensity: 1.0,
            });
            addToScene(scene, sphere);
        }
    }

    // Gentle auto-orbit (≈ one revolution every 40s); user drag still works.
    onBeforeRender(scene, (deltaMs) => {
        camera.alpha += (deltaMs / 1000) * 0.157;
    });

    await registerScene(scene);
    await startEngine(engine);
}

void main().catch((err) => console.error(err));
