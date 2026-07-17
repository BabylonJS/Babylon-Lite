// Demo — Break Meshes
// Loads the Khronos BoomBox glTF PBR model lit by an HDR environment (used as
// both IBL and a visible skybox). At startup it is fractured into Voronoi cells
// via `breakMesh` (ported from CedricGuillemet/64Kb5's DynamicsEdit.cpp, see
// ./break-mesh.ts) with UV interpolation, and duplicated into several instances
// scattered across the ground. Each instance rests assembled as static convex-hull
// cells; clicking one GPU-picks it and shatters just that boombox, punching the
// picked cell along the pick ray. Original surfaces keep the PBR material; the
// exposed interior cut faces use a separate "fractured core" material, and soft
// directional shadows track the cells.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    applyPhysicsImpulse,
    attachControl,
    createDefaultCamera,
    createDirectionalLight,
    createBox,
    createEngine,
    createEsmDirectionalShadowGenerator,
    createGpuPicker,
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
    onBeforeRender,
    pickAsync,
    PhysicsMotionType,
    PhysicsShapeType,
    registerSceneWithShadowSupport,
    removeFromScene,
    setCameraLimits,
    setParent,
    setPhysicsBodyMass,
    setPhysicsBodyMotionType,
    setPhysicsTimestepMs,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import type { Mesh, PhysicsBody } from "babylon-lite";
import { breakMesh } from "./break-mesh.js";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

const MODEL_URL = "https://playground.babylonjs.com/scenes/BoomBox.glb";
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";
const SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";

const CELL_COUNT = 14;

/** Total number of BoomBox instances (1 original + 10 duplicates scattered around). */
const INSTANCE_COUNT = 11;

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
    // Horizontal centre of the (baked, world-space) model — the pivot for per-instance
    // spin and the framing/ground centre.
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Material for the freshly exposed interior faces — a warm "fractured core".
    // PBR (not standard) so every shadow caster shares the PBR shadow family, which
    // avoids a lazy async shadow-shader module load on the first shadow frame.
    const coreMat = createPbrMaterial({
        baseColorFactor: [0.82, 0.3, 0.12, 1],
        metallicFactor: 0,
        roughnessFactor: 0.7,
        emissiveColor: [0.12, 0.03, 0.0],
    });

    // ── Build several fractured BoomBox instances scattered around the origin. The
    // first sits where the source model is; the others get random ground offsets.
    // Each instance is fractured with its own seed set (so the break pattern varies)
    // into a flush, on-the-ground assembly of static convex-hull cells that shatters
    // independently when one of its parts is picked.
    const inset = 0.12;
    const makeSeeds = (r: () => number): number[][] => {
        const s: number[][] = [];
        for (let i = 0; i < CELL_COUNT; i++) {
            s.push([
                minX + (inset + r() * (1 - 2 * inset)) * (maxX - minX),
                minY + (inset + r() * (1 - 2 * inset)) * (maxY - minY),
                minZ + (inset + r() * (1 - 2 * inset)) * (maxZ - minZ),
            ]);
        }
        return s;
    };

    // Random ground offsets: instance 0 at the origin, the rest scattered around it
    // within `spread`, rejecting placements that crowd a previously-placed instance.
    const spread = span * 8.5;
    const offRng = makeRng(9001);
    const offsets: [number, number][] = [[0, 0]];
    let guard = 0;
    while (offsets.length < INSTANCE_COUNT && guard++ < 2000) {
        const ang = offRng() * Math.PI * 2;
        const dist = span * 2.5 + offRng() * (spread - span * 2.5);
        const ox = Math.cos(ang) * dist;
        const oz = Math.sin(ang) * dist;
        if (offsets.every(([x, z]) => Math.hypot(x - ox, z - oz) > span * 2.2)) {
            offsets.push([ox, oz]);
        }
    }

    interface BoomboxInstance {
        roots: Mesh[];
        bodies: PhysicsBody[];
        shattered: boolean;
    }
    const instances: BoomboxInstance[] = [];
    const allPieces: Mesh[] = [];
    for (let i = 0; i < offsets.length; i++) {
        const [ox, oz] = offsets[i]!;
        const seeds = makeSeeds(makeRng(1337 + i * 131));
        // Random spin about the vertical axis. The cell geometry is baked in world
        // space around the model centre (cx, cz), so a plain mesh rotation would spin
        // it around the world origin — cancel the pivot in `position` so the instance
        // rotates about its own centre before being translated to (ox, oz).
        const theta = offRng() * Math.PI * 2;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const dpx = cx * (1 - cosT) - cz * sinT;
        const dpz = cx * sinT + cz * (1 - cosT);
        const qy = Math.sin(theta / 2);
        const qw = Math.cos(theta / 2);
        const roots: Mesh[] = [];
        for (const m of sourceMeshes) {
            for (const p of breakMesh(engine, m, seeds, coreMat, { separation: 0, receiveShadows: false })) {
                if (!p.parent) {
                    // Shell root: apply the Y spin and shift the whole cell (its cap
                    // child rides along) to this instance's ground offset. groundY ==
                    // the model's minY and a Y spin leaves height unchanged, so Y stays
                    // untouched to keep every instance flush on the ground.
                    p.rotationQuaternion.set(0, qy, 0, qw);
                    p.position.x = ox + dpx;
                    p.position.z = oz + dpz;
                    roots.push(p);
                }
                addToScene(scene, p);
                allPieces.push(p);
            }
        }
        instances.push({ roots, bodies: [], shattered: false });
    }
    for (const m of sourceMeshes) {
        removeFromScene(scene, m);
    }

    // Shadow-receiving ground plane the pieces land on.
    const groundW = span * 30;
    const ground = createGround(engine, { width: groundW, height: groundW });
    ground.position.set(cx, groundY, cz);
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.55, 0.55, 0.58];
    groundMat.specularColor = [0.05, 0.05, 0.05];
    ground.material = groundMat;
    ground.receiveShadows = true;
    addToScene(scene, ground);

    // Camera framing the whole scattered cluster (manual pose — the huge ground plane
    // would wreck createDefaultCamera's auto-framing).
    const cam = createDefaultCamera(scene);
    cam.target.x = cx;
    cam.target.y = groundY + span * 0.6;
    cam.target.z = cz;
    cam.alpha = 1.6;
    cam.beta = 1.12;
    cam.radius = span * 13;
    cam.nearPlane = span * 0.02;
    cam.farPlane = span * 4000;
    attachControl(cam, canvas, scene);
    setCameraLimits(cam, { lowerRadiusLimit: span * 2, upperRadiusLimit: span * 40, upperBetaLimit: Math.PI / 2 + 0.2 }, scene);

    // Straight top-down "sun". A vertical light casts shadows directly beneath each
    // piece, so they can never be stretched/elongated by a grazing light angle no
    // matter where a shard flies (buildLightViewMatrix swaps the up-vector for a
    // vertical direction, so [0,-1,0] is well-defined).
    const sun = createDirectionalLight([0, -1, 0], 1.1);
    sun.position.set(cx, groundY + span * 6, cz);
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

    // FIXED shadow volume mapping the ground. The generator auto-fits its ortho X/Y to
    // all caster AABBs each frame, so a flung shard would otherwise balloon the frustum
    // and blur/stretch every shadow. Pin the volume to a fixed square of the ground by
    // making four tiny invisible corner anchors permanent casters, and — since the
    // light is vertical, only horizontal position (not height) affects the X/Y fit —
    // drop any piece that strays outside that square from the caster set. The frustum
    // then stays a constant ground-mapped box: shadows keep a stable resolution and
    // never stretch. Anchors sit on the ground so their own (vertical) shadow is
    // coincident with it and invisible.
    const shadowHalf = span * 12;
    const anchors: Mesh[] = [];
    const corners: [number, number][] = [
        [-shadowHalf, -shadowHalf],
        [shadowHalf, -shadowHalf],
        [-shadowHalf, shadowHalf],
        [shadowHalf, shadowHalf],
    ];
    for (const [ax, az] of corners) {
        const a = createBox(engine, span * 0.02);
        a.position.set(cx + ax, groundY, cz + az);
        a.visible = false;
        addToScene(scene, a);
        anchors.push(a);
    }
    let currentCasters: Mesh[] = [...anchors, ...allPieces];
    setShadowTaskCasterMeshes(shadowGen, currentCasters);
    onBeforeRender(scene, () => {
        const next: Mesh[] = anchors.slice();
        for (const p of allPieces) {
            const wm = p.worldMatrix as ArrayLike<number>;
            const bmin = p.boundMin ?? [-0.5, -0.5, -0.5];
            const bmax = p.boundMax ?? [0.5, 0.5, 0.5];
            const lx = (bmin[0]! + bmax[0]!) * 0.5;
            const ly = (bmin[1]! + bmax[1]!) * 0.5;
            const lz = (bmin[2]! + bmax[2]!) * 0.5;
            const wx = wm[0]! * lx + wm[4]! * ly + wm[8]! * lz + wm[12]!;
            const wz = wm[2]! * lx + wm[6]! * ly + wm[10]! * lz + wm[14]!;
            if (Math.abs(wx - cx) <= shadowHalf && Math.abs(wz - cz) <= shadowHalf) {
                next.push(p);
            }
        }
        if (next.length !== currentCasters.length || next.some((m, i) => m !== currentCasters[i])) {
            currentCasters = next;
            setShadowTaskCasterMeshes(shadowGen, currentCasters);
        }
    });

    // ── Havok physics: one convex-hull body per cell + a static ground; gravity
    // pulls the pieces down. The world auto-steps in the render loop.
    const hknp = await HavokPhysics({ locateFile: () => demoAssetUrl("./HavokPhysics.wasm", import.meta.url) });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // The world advances ONE fixed step per rendered frame (scene.fixedDeltaMs), so
    // its wall-clock speed is tied to the frame cadence. Shrink the per-frame step to
    // slow the sim ~1.3× (8/6) — a light slow-mo that keeps the break snappy.
    setPhysicsTimestepMs(world, (1000 / 60 / 8) * 6);

    // One CONVEX_HULL body per cell. The hull must span BOTH the shell (the clipped
    // boombox surface) AND its cap child (the generated orange cut-face polygons), so
    // pass includeChildMeshes: true — the shape builder does NOT walk children unless
    // asked, and without it the hull would be built from the shell vertices alone.
    //
    // Each instance's cells are placed flush as an intact boombox, and convex hulls of
    // adjacent Voronoi cells always overlap slightly — so dynamic bodies would
    // immediately push each other apart and the model would burst. Keep every body
    // STATIC (mass 0) so the boomboxes rest stably on the ground; picking (below) flips
    // a single instance's cells to dynamic to break just that model on demand.
    const rootData = new Map<Mesh, { body: PhysicsBody; instance: BoomboxInstance }>();
    for (const inst of instances) {
        for (const root of inst.roots) {
            const shape = createPhysicsShape(world, { type: PhysicsShapeType.CONVEX_HULL, mesh: root, includeChildMeshes: true });
            const agg = createPhysicsAggregate(world, root, PhysicsShapeType.CONVEX_HULL, { mass: 0, restitution: 0.2, friction: 0.6, shape });
            inst.bodies.push(agg.body);
            rootData.set(root, { body: agg.body, instance: inst });
        }
    }
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0, restitution: 0.1, friction: 0.8 });

    // ── Interaction: click a boombox part to shatter THAT boombox. The first pick on
    // an instance flips all its cells from static to dynamic (gravity + the overlapping
    // hulls then burst it apart) and punches the clicked cell along the pick ray; later
    // picks just punch whatever cell is clicked. Other instances stay intact.
    const picker = createGpuPicker(scene);
    const IMPULSE = span * 24;
    const punchAt = async (clientX: number, clientY: number): Promise<void> => {
        const rect = canvas.getBoundingClientRect();
        const info = await pickAsync(picker, clientX - rect.left, clientY - rect.top);
        if (!info.hit || !info.pickedMesh) {
            return;
        }
        // Resolve the picked mesh (a shell root, or its cap child) to the cell root
        // that owns the physics body.
        let root: Mesh | null = info.pickedMesh as Mesh;
        while (root && !rootData.has(root)) {
            root = root.parent as Mesh | null;
        }
        if (!root) {
            return; // clicked the ground (or anything without a cell body)
        }
        const hit = rootData.get(root)!;
        if (!hit.instance.shattered) {
            hit.instance.shattered = true;
            for (const b of hit.instance.bodies) {
                setPhysicsBodyMotionType(world, b, PhysicsMotionType.DYNAMIC);
                setPhysicsBodyMass(world, b, 1);
            }
        }
        const d = info.ray?.direction ?? [0, -1, 0];
        const point = info.pickedPoint;
        applyPhysicsImpulse(world, hit.body, { x: d[0]! * IMPULSE, y: d[1]! * IMPULSE, z: d[2]! * IMPULSE }, point ? { x: point[0], y: point[1], z: point[2] } : undefined);
    };
    // Only treat a near-stationary press/release as a click, so camera-orbit drags
    // don't trigger a pick.
    let downX = 0;
    let downY = 0;
    let downT = 0;
    canvas.addEventListener("pointerdown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
        downT = performance.now();
    });
    canvas.addEventListener("pointerup", (e) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) < 6 && performance.now() - downT < 500) {
            void punchAt(e.clientX, e.clientY);
        }
    });

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
