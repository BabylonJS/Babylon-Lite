// Scene 105: Physics V2 — Havok PhysicsCharacterController level walk + moving platform
// (port of PG #WO0H1U#166). This is scene104 PLUS a procedural kinematic (ANIMATED) platform that
// rotates about Y and bobs vertically, and a different start camera position (5,5,-5) so the
// character's camera-space "forward" points toward −x,−z.
//
// Loads levelTest.glb as the visible level. A flip-baked merged MESH collider reproduces the
// level surface (Lite physics bodies use local transforms, so the RH→LH glTF root flip is baked
// into the collision mesh). A PhysicsCharacterController capsule walks forward for a fixed number
// of physics steps; the display capsule follows getPosition(). A cluster of dynamic boxes is placed
// in the auto-test path so the character walks into them and the controller's
// onTriggerCollisionObservable reports each contacted box. The moving platform is driven from the
// FIXED physics step (count-based, not wall-clock) so Lite and BJS stay bit-deterministic. The
// camera follows the character in camera space.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    cloneTransformNode,
    createBox,
    createCapsule,
    createEngine,
    createFreeCamera,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsCharacterController,
    createPhysicsConstraint,
    createPhysicsShape,
    createSceneContext,
    createStandardMaterial,
    createTransformNode,
    loadGltf,
    loadTexture2D,
    onPhysicsAfterStep,
    PhysicsConstraintType,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMotionType,
    setPhysicsBodyShape,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { AssetContainer, FreeCamera, Mesh, PbrMaterialProps, PhysicsWorld, SceneNode } from "babylon-lite";

const PHYSICS_FPS = 60;
const LEVEL_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/CharController/levelTest.glb";
const LIGHTMAP_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/CharController/lightmap.jpg";
const CAPTURE_FRAMES = 105;
const CHARACTER_START = { x: 3, y: 0.3, z: -8 };
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.6;
// In automatic parity testing the character walks steered toward −x,−z (toward the moving platform
// at (-4,-12)) so the captured frame is deterministic. In interactive mode it starts idle (y bias
// only) and keyboard input drives it. The input vector is rotated into camera space each step; with
// the (5,5,-5) start camera, (x:0.57, z:2) aims the character at the platform.
const AUTOTEST_INPUT = { x: 0.57, y: -0.5, z: 2 };
const IDLE_INPUT = { x: 0, y: -0.5, z: 0 };

// Decorative static boxes (glTF "Cube"…"Cube.005"), positions taken from the glTF nodes with the
// root RH→LH X flip applied (worldX = -nodeX). Boxes are symmetric so orientation is unused.
const CUBES = [
    { x: 5.1167, y: -0.2178, z: -8.9338 },
    { x: 5.1167, y: -0.2178, z: -10.194 },
    { x: 5.1167, y: 0.7922, z: -9.5777 },
    { x: 5.1167, y: -0.2178, z: -11.4473 },
    { x: 5.2025, y: 0.7852, z: -10.9095 },
    { x: 5.0466, y: 1.7915, z: -10.2446 },
];
const CUBE_COLOR: [number, number, number] = [0.45, 0.55, 0.85];

// Moving ANIMATED platform (PG #WO0H1U#166): a 4×0.2×4 box at world (-4,0,-12) that rotates about Y
// and bobs in Y. Driven count-based from the fixed physics step (see PLATFORM_ROT_PER_STEP /
// PLATFORM_TIME_PER_STEP) so Lite and BJS stay bit-identical.
const PLATFORM_POS = { x: -4, y: 0, z: -12 };
const PLATFORM_SIZE = { w: 4, h: 0.2, d: 4 };
const PLATFORM_ROT_PER_STEP = 0.005; // rad/step about Y (matches #166's per-frame rotate(Y, 0.005))
const PLATFORM_TIME_PER_STEP = 1 / PHYSICS_FPS; // platformTime += dt; y = sin(platformTime)*2 + 1.2

// Dynamic obstacle boxes (mass 0.1) placed as a "gate" straddling the auto-test path just before the
// moving platform so the wide character capsule touches all three; the controller's
// onTriggerCollisionObservable then fires on each. Placed at their resting height (y=-0.1 on the flat
// ground here) so they are immobile until contact, keeping the pre-contact visual frame deterministic.
const OBSTACLES = [
    { x: -1.02, y: -0.1, z: -11.41 },
    { x: -1.54, y: -0.1, z: -10.45 },
    { x: -2.1, y: -0.1, z: -11.4 },
];

function readCaptureFrames(): number {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("captureFrame");
    if (value !== null) {
        const frame = Number(value);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_FRAMES;
    }
    return CAPTURE_FRAMES;
}

/** Camera follow ported from the playground: lerp the target toward the character, dolly along the
 *  ground-projected forward to keep the character within [6, 9] units, and ease the height. */
function updateCameraFollow(camera: FreeCamera, target: { x: number; y: number; z: number }): void {
    // Ground-projected forward (y=0), normalized, from the current camera.
    let fx = camera.target.x - camera.position.x;
    let fz = camera.target.z - camera.position.z;
    const flen = Math.hypot(fx, fz) || 1;
    fx /= flen;
    fz /= flen;
    // Lerp the look-at target toward the character.
    camera.target.set(
        camera.target.x + (target.x - camera.target.x) * 0.1,
        camera.target.y + (target.y - camera.target.y) * 0.1,
        camera.target.z + (target.z - camera.target.z) * 0.1
    );
    // Dolly along forward so distance stays within [6, 9]; ease the height toward character + 2.
    const dist = Math.hypot(camera.position.x - target.x, camera.position.y - target.y, camera.position.z - target.z);
    const amount = (Math.min(dist - 6, 0) + Math.max(dist - 9, 0)) * 0.04;
    camera.position.set(camera.position.x + fx * amount, camera.position.y + (target.y + 2 - camera.position.y) * 0.04, camera.position.z + fz * amount);
}

function makeMaterial(color: [number, number, number]) {
    const mat = createStandardMaterial();
    mat.diffuseColor = color;
    mat.specularColor = [0.04, 0.04, 0.04];
    return mat;
}

/** Drive the character's input vector from the keyboard: WASD / arrow keys for X/Z, space to jump. */
function wireKeyboardInput(input: { x: number; y: number; z: number }): void {
    window.addEventListener("keydown", (e) => {
        switch (e.key) {
            case "w":
            case "ArrowUp":
                input.z = 1;
                break;
            case "s":
            case "ArrowDown":
                input.z = -1;
                break;
            case "a":
            case "ArrowLeft":
                input.x = -1;
                break;
            case "d":
            case "ArrowRight":
                input.x = 1;
                break;
            case " ":
                input.y = 1;
                break;
        }
    });
    window.addEventListener("keyup", (e) => {
        switch (e.key) {
            case "w":
            case "s":
            case "ArrowUp":
            case "ArrowDown":
                input.z = 0;
                break;
            case "a":
            case "d":
            case "ArrowLeft":
            case "ArrowRight":
                input.x = 0;
                break;
            case " ":
                input.y = -0.5;
                break;
        }
    });
}

function isMeshNode(node: unknown): node is Mesh {
    return typeof node === "object" && node !== null && "_gpu" in node;
}

function hasChildren(node: unknown): node is SceneNode {
    return typeof node === "object" && node !== null && "children" in node && Array.isArray((node as { children?: unknown }).children);
}

/** Walk the loaded container, mapping each named glTF transform node to its mesh children. */
function collectByOwner(node: SceneNode, ownerName: string, out: Map<string, Mesh[]>): void {
    for (const child of node.children) {
        if (isMeshNode(child)) {
            const list = out.get(ownerName) ?? [];
            list.push(child);
            out.set(ownerName, list);
        }
        if (hasChildren(child)) {
            collectByOwner(child, isMeshNode(child) ? ownerName : child.name, out);
        }
    }
}

function buildOwnerMap(container: AssetContainer): Map<string, Mesh[]> {
    const out = new Map<string, Mesh[]>();
    for (const entity of container.entities) {
        if (hasChildren(entity)) {
            collectByOwner(entity, entity.name, out);
        }
    }
    return out;
}

/** Collect every mesh node in the subtree (used to strip all glTF PBR materials). */
function collectAllMeshes(node: unknown, out: Mesh[]): void {
    if (isMeshNode(node)) {
        out.push(node);
    }
    if (hasChildren(node)) {
        for (const child of node.children) {
            collectAllMeshes(child, out);
        }
    }
}

/** Build the static level collider: clone the level meshes under an X-flip node so the merged
 *  MESH shape vertices match Babylon.js' world-space (flipped) level geometry, then create one
 *  static body at the origin. */
function buildLevelCollider(world: PhysicsWorld, levelMeshes: Mesh[]): void {
    const flip = createTransformNode("levelFlip", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
    for (const mesh of levelMeshes) {
        const clone = cloneTransformNode(mesh) as Mesh;
        clone.position.set(0, 0, 0);
        clone.scaling.set(1, 1, 1);
        clone.rotationQuaternion.set(0, 0, 0, 1);
        clone.parent = flip;
        flip.children.push(clone);
    }
    const shape = createPhysicsShape(world, { type: PhysicsShapeType.MESH, mesh: flip, includeChildMeshes: true });
    const body = createPhysicsBody(world, flip, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, body, shape);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const autoTest = new URLSearchParams(window.location.search).has("captureFrame");
    const captureFrames = readCaptureFrames();

    const camera = createFreeCamera({ x: 5, y: 5, z: -5 }, CHARACTER_START);
    scene.camera = camera;

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // Load the level and keep only the level meshes visible (props are rebuilt procedurally).
    const container = await loadGltf(engine, LEVEL_URL);
    const owners = buildOwnerMap(container);
    const levelMeshes = owners.get("level") ?? [];
    const levelSet = new Set(levelMeshes);
    // Baked lightmap (PG #WO0H1U#165): multiplied into the level as a shadowmap, sampled on UV2,
    // intensity 3.2, with the BJS uAng = π V-flip.
    const lightmap = await loadTexture2D(engine, LIGHTMAP_URL);
    lightmap.uAng = Math.PI;
    // The level uses Standard materials (glTF baseColor grid texture as diffuse); the baked lightmap
    // is applied as a shadowmap (multiply) on UV2 (zero PBR bundle cost). Non-level prop meshes are hidden (rebuilt procedurally).
    const allMeshes: Mesh[] = [];
    for (const entity of container.entities) {
        collectAllMeshes(entity, allMeshes);
    }
    for (const mesh of allMeshes) {
        const isLevel = levelSet.has(mesh);
        if (isLevel) {
            const pbr = mesh.material as PbrMaterialProps;
            const mat = createStandardMaterial();
            if (pbr.baseColorTexture) {
                mat.diffuseTexture = pbr.baseColorTexture;
            }
            mat.specularColor = [0, 0, 0];
            mat.lightmapTexture = lightmap;
            mat.useLightmapAsShadowmap = true;
            mat.lightmapLevel = 3.2;
            mat.lightmapCoordIndex = 1;
            mesh.material = mat;
        } else {
            mesh.material = makeMaterial(CUBE_COLOR);
            mesh.visible = false;
        }
    }
    addToScene(scene, container);

    buildLevelCollider(world, levelMeshes);

    // Decorative box pyramid (glTF scenery cubes). Dynamic (mass 0.1) so the character pushes them
    // and the controller's onTriggerCollisionObservable fires — both in interactive and auto-test
    // mode (the parity spec asserts the SET of colliders contacted, which is deterministic up to and
    // shortly after first contact even though the freely-simulated boxes later diverge between the
    // Lite and BJS Havok builds).
    const boxMass = 0.1;
    CUBES.forEach((p, i) => {
        const box = createBox(engine, 1);
        box.name = "cube" + i;
        box.position.set(p.x, p.y, p.z);
        box.material = makeMaterial(CUBE_COLOR);
        addToScene(scene, box);
        createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: boxMass });
    });

    // Dynamic obstacle boxes (mass 0.1) directly in the auto-test path so the character walks into
    // them and onTriggerCollisionObservable fires. Named identically in Lite + BJS.
    OBSTACLES.forEach((p, i) => {
        const box = createBox(engine, 1);
        box.name = "obstacle" + i;
        box.position.set(p.x, p.y, p.z);
        box.material = makeMaterial(CUBE_COLOR);
        addToScene(scene, box);
        createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: boxMass });
    });

    // Moving ANIMATED platform (PG #WO0H1U#166). Procedural box in WORLD coords (no -X flip). Built
    // as a kinematic (ANIMATED) body with disablePreStep=false equivalent: Lite always syncs ANIMATED
    // bodies node→Havok in the pre-step, so updating the mesh transform each physics step drives the
    // body. Animation is advanced count-based in onPhysicsAfterStep below.
    const platform = createBox(engine, 1);
    platform.name = "movingPlatform";
    platform.scaling.set(PLATFORM_SIZE.w, PLATFORM_SIZE.h, PLATFORM_SIZE.d);
    platform.position.set(PLATFORM_POS.x, PLATFORM_POS.y, PLATFORM_POS.z);
    platform.material = makeMaterial(CUBE_COLOR);
    addToScene(scene, platform);
    const platformAgg = createPhysicsAggregate(world, platform, PhysicsShapeType.BOX, {
        mass: 0,
        extents: { x: PLATFORM_SIZE.w, y: PLATFORM_SIZE.h, z: PLATFORM_SIZE.d },
    });
    setPhysicsBodyMotionType(world, platformAgg.body, PhysicsMotionType.ANIMATED);

    // Hinged swinging plane (glTF Cube.007 fixed anchor + Cube.006 plane, X-flipped world positions),
    // joined by a hinge constraint. Dynamic + non-deterministic, so it is built only in interactive
    // mode — skipped in auto-test to keep the parity capture deterministic.
    if (!autoTest) {
        const fixedMesh = createBox(engine, 2);
        fixedMesh.position.set(19.0498, -0.4281, -11.6688);
        // glTF Cube.007 rotation (0,0,√½,√½) reflected for the -X world flip → (0,0,-√½,√½).
        fixedMesh.rotationQuaternion.set(0, 0, -0.70710678, 0.70710678);
        fixedMesh.scaling.set(0.2782, 0.0667, 0.6894);
        fixedMesh.material = makeMaterial(CUBE_COLOR);
        addToScene(scene, fixedMesh);
        const fixed = createPhysicsAggregate(world, fixedMesh, PhysicsShapeType.BOX, {
            mass: 0,
            extents: { x: 2 * 0.2782, y: 2 * 0.0667, z: 2 * 0.6894 },
        });

        const planeMesh = createBox(engine, 2);
        // Author the plane at the hinge's settled equilibrium (recorded by letting the live
        // constraint rest) so it starts immobile yet stays an active, properly-aligned hinge the
        // player can still knock. (glTF authoring pose 19.1198,-0.0508,-11.6786 / quat
        // -0.5,-0.5,0.5,0.5 would visibly swing down to settle.)
        planeMesh.position.set(19.045139, 0.071943, -11.6688);
        planeMesh.rotationQuaternion.set(0.713661, 0.700491, 0, 0);
        planeMesh.scaling.set(0.03, 3, 1);
        planeMesh.material = makeMaterial(CUBE_COLOR);
        addToScene(scene, planeMesh);
        const plane = createPhysicsAggregate(world, planeMesh, PhysicsShapeType.BOX, {
            mass: 0.1,
            extents: { x: 2 * 0.03, y: 2 * 3, z: 2 * 1 },
        });

        createPhysicsConstraint(world, fixed.body, plane.body, PhysicsConstraintType.HINGE, {
            // Pivots have their X negated vs the playground because the bodies live in the -X
            // reflected world (anchors then coincide as in PG #WO0H1U#165). Axes have X=0 so are unchanged.
            pivotA: { x: -0.75, y: 0, z: 0 },
            pivotB: { x: 0.25, y: 0, z: 0 },
            axisA: { x: 0, y: 0, z: -1 },
            axisB: { x: 0, y: 0, z: 1 },
        });
    }

    // Character: display capsule + physics character controller.
    const displayCapsule = createCapsule(engine, { height: CAPSULE_HEIGHT, radius: CAPSULE_RADIUS });
    displayCapsule.material = makeMaterial([0.85, 0.55, 0.2]);
    displayCapsule.position.set(CHARACTER_START.x, CHARACTER_START.y, CHARACTER_START.z);
    addToScene(scene, displayCapsule);

    const character = createPhysicsCharacterController(world, CHARACTER_START, { capsuleHeight: CAPSULE_HEIGHT, capsuleRadius: CAPSULE_RADIUS });

    // Record character→collider contacts (ported from PG #WO0H1U#169). Logged like the playground,
    // and (in auto-test) accumulated for the parity spec, which asserts the set of colliders
    // contacted matches between Lite and BJS.
    const collisions: { collider: string; impulsePosition: { x: number; y: number; z: number } }[] = [];
    character.onTriggerCollisionObservable.add((event) => {
        const pos = event.impulsePosition;
        // eslint-disable-next-line no-console
        console.log(`Character collision : ${event.collider.node.name} at (${pos.x}, ${pos.y}, ${pos.z})`);
        if (autoTest) {
            collisions.push({ collider: event.collider.node.name, impulsePosition: { x: round(pos.x), y: round(pos.y), z: round(pos.z) } });
        }
    });

    // Automatic parity test: walk forward a fixed number of steps, then freeze and capture.
    // Interactive mode: idle until the user drives the character with the keyboard (WASD / arrows,
    // space to jump), and keep rendering indefinitely.
    const inputDirection = autoTest ? { ...AUTOTEST_INPUT } : { ...IDLE_INPUT };
    if (!autoTest) {
        wireKeyboardInput(inputDirection);
    }

    let steps = 0;
    let captureQueued = false;
    let platformTime = 0;
    let platformAngle = 0;
    onPhysicsAfterStep(world, (dt) => {
        // Advance the moving platform count-based (NOT wall-clock) so Lite and BJS match exactly.
        platformAngle += PLATFORM_ROT_PER_STEP;
        platformTime += PLATFORM_TIME_PER_STEP;
        const half = platformAngle * 0.5;
        platform.rotationQuaternion.set(0, Math.sin(half), 0, Math.cos(half));
        platform.position.set(PLATFORM_POS.x, Math.sin(platformTime) * 2 + 1.2, PLATFORM_POS.z);

        // Move the character in CAMERA space: rotate the input by the camera yaw around Y.
        const yaw = Math.atan2(camera.target.x - camera.position.x, camera.target.z - camera.position.z);
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        const s = dt * 2;
        const displacement = {
            x: (inputDirection.x * cos + inputDirection.z * sin) * s,
            y: inputDirection.y * s,
            z: (-inputDirection.x * sin + inputDirection.z * cos) * s,
        };
        character.moveWithCollisions(displacement);
        const p = character.getPosition();
        displayCapsule.position.set(p.x, p.y, p.z);
        updateCameraFollow(camera, p);
        if (!autoTest) {
            return;
        }
        steps++;
        if (!captureQueued && steps >= captureFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.charPos = JSON.stringify({ x: round(p.x), y: round(p.y), z: round(p.z) });
                canvas.dataset.collisions = JSON.stringify(collisions);
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
