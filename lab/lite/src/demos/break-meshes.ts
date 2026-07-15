// Demo — Break Meshes
// Loads the Khronos BoomBox glTF PBR model lit by an HDR environment (used as
// both IBL and a visible skybox). At startup it is fractured into Voronoi cells
// via `breakMesh` (ported from CedricGuillemet/64Kb5's DynamicsEdit.cpp, see
// ./break-mesh.ts) with UV interpolation, each cell gets its own Havok convex-hull
// rigid body, and the pieces are dropped so they fall and scatter on the ground.
// Original surfaces keep the PBR material; the exposed interior cut faces use a
// separate "fractured core" material. Soft directional shadows track the pieces.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    attachControl,
    createDefaultCamera,
    createDirectionalLight,
    createEngine,
    createEsmDirectionalShadowGenerator,
    createGround,
    createHavokWorld,
    createPhysicsAggregate,
    createPhysicsShape,
    createPbrMaterial,
    createSceneContext,
    createStandardMaterial,
    getContainerMeshes,
    loadEnvironment,
    loadGltf,
    PhysicsShapeType,
    registerSceneWithShadowSupport,
    removeFromScene,
    setCameraLimits,
    setParent,
    setPhysicsTimestepMs,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { breakMesh } from "./break-mesh.js";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

const MODEL_URL = "https://playground.babylonjs.com/scenes/BoomBox.glb";
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";
const SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";

const CELL_COUNT = 14;

/** Small deterministic RNG (mulberry32) so the fracture is stable across loads. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Transform a point by a column-major mat4 (as stored in mesh.worldMatrix). */
function transformPoint(m: ArrayLike<number>, p: number[]): number[] {
    const x = p[0]!;
    const y = p[1]!;
    const z = p[2]!;
    return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 2_000_000 });

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / 60; // fixed 60 Hz physics step

    // Resolve the glTF decoders + brdf LUT relative to this demo module so the
    // deployed demos site finds them under any base path.
    await configureDemoDecoderBases(import.meta.url);

    const asset = await loadGltf(engine, MODEL_URL);
    addToScene(scene, asset);

    await loadEnvironment(scene, ENV_URL, {
        // IBL from the .env plus a visible HDR skybox background.
        skyboxUrl: SKYBOX_URL,
        skyboxSize: 1000,
        skipGround: true, // we add our own shadow-receiving ground below
        brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
    });

    const sourceMeshes = getContainerMeshes(asset);

    // Detach each source mesh from its glTF parent so we can scale/transform it
    // directly.
    for (const m of sourceMeshes) {
        setParent(m, null);
    }

    // Combined world AABB from CPU geometry (recomputed after scaling below).
    const worldAabb = (): { min: number[]; max: number[] } => {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const m of sourceMeshes) {
            const pos = (m as unknown as { _cpuPositions?: Float32Array })._cpuPositions;
            if (!pos) {
                continue;
            }
            const wm = m.worldMatrix as unknown as ArrayLike<number>;
            for (let i = 0; i < pos.length; i += 3) {
                const p = transformPoint(wm, [pos[i]!, pos[i + 1]!, pos[i + 2]!]);
                for (let a = 0; a < 3; a++) {
                    min[a] = Math.min(min[a]!, p[a]!);
                    max[a] = Math.max(max[a]!, p[a]!);
                }
            }
        }
        return { min, max };
    };

    // The BoomBox.glb is authored sub-centimetre (~0.02 units across). Havok's
    // collision margins misbehave at that size — the shards get treated as
    // permanently in contact and jam instead of falling cleanly — so scale the
    // model up to a normal physics size (~1 unit) first.
    const raw = worldAabb();
    const rawSpan = Math.max(raw.max[0]! - raw.min[0]!, raw.max[1]! - raw.min[1]!, raw.max[2]! - raw.min[2]!, 1e-6);
    const SCALE = 1 / rawSpan;
    for (const m of sourceMeshes) {
        m.scaling.x *= SCALE;
        m.scaling.y *= SCALE;
        m.scaling.z *= SCALE;
    }

    // Bounds of the scaled model.
    const aabb = worldAabb();
    const minX = aabb.min[0]!;
    const minY = aabb.min[1]!;
    const minZ = aabb.min[2]!;
    const maxX = aabb.max[0]!;
    const maxY = aabb.max[1]!;
    const maxZ = aabb.max[2]!;
    const groundY = isFinite(minY) ? minY : 0;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);

    // Material for the freshly exposed interior faces — a warm "fractured core".
    // PBR (not standard) so every shadow caster shares the PBR shadow family, which
    // avoids a lazy async shadow-shader module load on the first shadow frame.
    const coreMat = createPbrMaterial({
        baseColorFactor: [0.82, 0.3, 0.12, 1],
        metallicFactor: 0,
        roughnessFactor: 0.7,
        emissiveColor: [0.12, 0.03, 0.0],
    });

    // ── Fracture the BoomBox into Voronoi cells NOW, at scene startup. Scatter
    // deterministic seed sites inside the scaled model bounds (inset so cells near
    // the surface still get a full complement of cut planes), fracture, then swap
    // the intact model out for the generated pieces.
    const rng = makeRng(1337);
    const inset = 0.12;
    const seeds: number[][] = [];
    for (let i = 0; i < CELL_COUNT; i++) {
        seeds.push([
            minX + (inset + rng() * (1 - 2 * inset)) * (maxX - minX),
            minY + (inset + rng() * (1 - 2 * inset)) * (maxY - minY),
            minZ + (inset + rng() * (1 - 2 * inset)) * (maxZ - minZ),
        ]);
    }

    const pieces: Mesh[] = [];
    for (const m of sourceMeshes) {
        pieces.push(...breakMesh(engine, m, seeds, coreMat, { separation: 0.04, receiveShadows: false }));
    }
    for (const m of sourceMeshes) {
        removeFromScene(scene, m);
    }
    // Lift the pieces above the ground and add them so they fall. Each cell's shell
    // is a scene root (parent == null); its cap rides along as a child, so moving/
    // adding the root moves the whole cell.
    const dropHeight = span * 2;
    for (const p of pieces) {
        if (!p.parent) {
            p.position.y += dropHeight;
        }
        addToScene(scene, p);
    }

    // Shadow-receiving ground plane the pieces land on.
    const groundW = span * 30;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const ground = createGround(engine, { width: groundW, height: groundW });
    ground.position.set(cx, groundY, cz);
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.55, 0.55, 0.58];
    groundMat.specularColor = [0.05, 0.05, 0.05];
    ground.material = groundMat;
    ground.receiveShadows = true;
    addToScene(scene, ground);

    // Camera framing the drop + landing area (manual pose — the huge ground plane
    // would wreck createDefaultCamera's auto-framing).
    const cam = createDefaultCamera(scene);
    cam.target.x = cx;
    cam.target.y = groundY + span * 1.4;
    cam.target.z = cz;
    cam.alpha = 1.6;
    cam.beta = 1.1;
    cam.radius = span * 6.5;
    cam.nearPlane = span * 0.02;
    cam.farPlane = span * 4000;
    attachControl(cam, canvas, scene);
    setCameraLimits(cam, { lowerRadiusLimit: span * 2, upperRadiusLimit: span * 30, upperBetaLimit: Math.PI / 2 + 0.2 }, scene);

    // Directional "sun" for the shadows, tilted modestly off vertical so the pile
    // casts a readable shadow onto the surrounding ground rather than hiding it
    // straight underneath.
    const lightDir = [0.35, -1, 0.28];
    const sun = createDirectionalLight([lightDir[0]!, lightDir[1]!, lightDir[2]!], 1.1);
    const lightPos = [cx - span * 1.4, groundY + span * 4, cz - span * 1.1];
    sun.position.set(lightPos[0]!, lightPos[1]!, lightPos[2]!);
    addToScene(scene, sun);

    // ESM ortho depth (near/far along the light axis, measured from the light eye at
    // sun.position). The generator refits the frustum's X/Y to the casters every
    // frame, but its near/far Z is a FIXED config value — NOT auto-fit.
    //
    // The ESM shadow map is rgba16float and stores exp(-depthScale * normalizedDepth),
    // where normalizedDepth = (viewZ - near) / (far - near) ∈ [0, 1]. If the range is
    // too TIGHT, a caster's normalized depth climbs toward 1 and exp(-depthScale·depth)
    // UNDERFLOWS to 0 in f16 — the stored occluder depth is lost and the shadow
    // silently vanishes (worst exactly as pieces near the ground, i.e. the "shadow
    // disappears near the ground" bug). Keeping a WIDE range holds every caster at a
    // small normalized depth so the stored exponential stays well inside f16 range and
    // the shadow is robust through the whole fall down to contact.
    const orthoMinZ = span * 0.1;
    const orthoMaxZ = span * 40;

    // Blurred (ESM) directional shadow. forceRefreshEveryFrame so the shadow map
    // re-renders each frame to track the falling pieces.
    const shadowGen = createEsmDirectionalShadowGenerator(engine, sun, {
        mapSize: 2048,
        depthScale: 50,
        bias: 0.001,
        blurKernel: 16,
        blurScale: 2,
        darkness: 0.25,
        orthoMinZ,
        orthoMaxZ,
        forceRefreshEveryFrame: true,
    });
    sun.shadowGenerator = shadowGen;
    setShadowTaskCasterMeshes(shadowGen, pieces);

    // ── Havok physics: one convex-hull body per cell + a static ground; gravity
    // pulls the pieces down. The world auto-steps in the render loop.
    const hknp = await HavokPhysics({ locateFile: () => demoAssetUrl("./HavokPhysics.wasm", import.meta.url) });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // The world advances ONE fixed step per rendered frame (scene.fixedDeltaMs), so
    // its wall-clock speed is tied to the frame cadence. Shrink the per-frame step
    // to slow the fall ~8×.
    setPhysicsTimestepMs(world, 1000 / 60 / 8);

    // One CONVEX_HULL body per cell. The hull must span BOTH the shell (the clipped
    // boombox surface) AND its cap child (the generated orange cut-face polygons), so
    // pass includeChildMeshes: true — the shape builder does NOT walk children unless
    // asked, and without it the hull would be built from the shell vertices alone.
    for (const p of pieces) {
        if (p.parent) {
            continue; // caps ride their shell — no separate body
        }
        const shape = createPhysicsShape(world, { type: PhysicsShapeType.CONVEX_HULL, mesh: p, includeChildMeshes: true });
        createPhysicsAggregate(world, p, PhysicsShapeType.CONVEX_HULL, { mass: 1, restitution: 0.2, friction: 0.6, shape });
    }
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0, restitution: 0.1, friction: 0.8 });

    await registerSceneWithShadowSupport(scene);
    progress.done();
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
