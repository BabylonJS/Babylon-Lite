// Scene 20: PBR Emissive Spheres Grid — 2500 spheres with random emissive colors
// Based on playground #6HWS9M#85 (without performancePriority)

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, attachControl, createSphere, createPbrMaterial, createSolidTexture2D, loadEnvironment, createHemisphericLight, setParent, registerScene } from "babylon-lite";
import type { Mesh } from "babylon-lite";

// Seeded PRNG for deterministic positions/colors across BJS and Lite
function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0x100000000;
    };
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: matching playground exactly
    const cam = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 80, { x: 0, y: 0, z: 0 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // Light
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const random = seededRandom(42);

    const sphereCount = 2500;
    const materialCount = 150;

    // BJS PBRMaterial defaults: specular-glossiness, microSurface=1.0 (roughness=0), white base
    // In Lite metallic-roughness: ORM with roughness=0, metallic=0 matches this
    const baseColorTex = createSolidTexture2D(engine, 1.0, 1.0, 1.0);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.0, 0.0); // occlusion=1, roughness=0, metallic=0

    const materials = [];
    for (let i = 0; i < materialCount; i++) {
        const r = random(),
            g = random(),
            b = random();
        // Use float emissiveColor uniform — matches BJS PBRMaterial.emissiveColor (no 8-bit quantization)
        materials.push(
            createPbrMaterial({
                baseColorTexture: baseColorTex,
                ormTexture: ormTex,
                emissiveColor: [r, g, b],
                reflectance: 1.0,
            })
        );
    }

    // Create 2500 spheres with random positions
    const meshes: Mesh[] = [];
    for (let i = 0; i < sphereCount; i++) {
        const sphere = createSphere(engine, { diameter: 2, segments: 32 });
        sphere.position.set(20 - random() * 40, 20 - random() * 40, 20 - random() * 40);
        sphere.material = materials[i % materialCount]!;
        meshes.push(sphere);
    }

    // Parent hierarchy (chains of 5)
    const levelMax = 5;
    let level = 0;
    for (let i = 0; i < sphereCount; i++) {
        if (level !== 0) {
            setParent(meshes[i]!, meshes[i - 1]!);
        }
        level++;
        if (level >= levelMax) {
            level = 0;
        }
    }

    // Add all meshes to scene
    for (const m of meshes) {
        addToScene(scene, m);
    }

    // Environment AFTER spheres (so background sizing matches BJS createDefaultEnvironment)
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        brdfUrl: "/brdf-lut.png",
    });

    // Fixed timestep for deterministic animation
    scene.fixedDeltaMs = 16.0;

    // seekTime support for parity testing
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frozen = false;

    onBeforeRender(scene, (_delta: number) => {
        if (frozen) {
            return;
        }

        // If seekTime=0, freeze immediately (no rotation)
        if (!isNaN(seekTimeParam)) {
            if (seekTimeParam === 0) {
                frozen = true;
                canvas.dataset.animationFrozen = "true";
                return;
            }
            // Advance seekTime*60 frames of rotation, then freeze
            const seekFrames = seekTimeParam * 60;
            for (let f = 0; f < seekFrames; f++) {
                for (const m of meshes) {
                    m.rotation.y += 0.01;
                }
            }
            frozen = true;
            canvas.dataset.animationFrozen = "true";
            return;
        }

        // Normal per-frame rotation
        for (const m of meshes) {
            m.rotation.y += 0.01;
        }
    });

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

void main();
