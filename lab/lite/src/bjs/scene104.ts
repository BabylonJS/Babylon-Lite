// Scene 104: Physics V2 — Havok PhysicsCharacterController level walk (port of PG #WO0H1U#165, BJS reference).

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { HingeConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import "@babylonjs/core/Animations/animatable";

const PHYSICS_FPS = 60;
const LEVEL_BASE = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/CharController/";
const CAPTURE_FRAMES = 55;
const CHARACTER_START = new Vector3(3, 0.3, -8);
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.6;
const AUTOTEST_INPUT = new Vector3(0, -0.5, 1);
const IDLE_INPUT = new Vector3(0, -0.5, 0);

const CUBES = [
    new Vector3(5.1167, -0.2178, -8.9338),
    new Vector3(5.1167, -0.2178, -10.194),
    new Vector3(5.1167, 0.7922, -9.5777),
    new Vector3(5.1167, -0.2178, -11.4473),
    new Vector3(5.2025, 0.7852, -10.9095),
    new Vector3(5.0466, 1.7915, -10.2446),
];
const CUBE_COLOR = new Color3(0.45, 0.55, 0.85);

function readCaptureFrames(): number {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("captureFrame");
    if (value !== null) {
        const frame = Number(value);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_FRAMES;
    }
    return CAPTURE_FRAMES;
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureFrames = readCaptureFrames();
    const autoTest = new URLSearchParams(window.location.search).has("captureFrame");

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    // Deterministic frame delta so the live-captured reference is stable across runs.
    scene.useConstantAnimationDeltaTime = true;

    const camera = new FreeCamera("camera1", new Vector3(0, 5, -5), scene);
    camera.setTarget(CHARACTER_START.clone());

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    const makeMaterial = (color: Color3): StandardMaterial => {
        const mat = new StandardMaterial("mat", scene);
        mat.diffuseColor = color;
        mat.specularColor = new Color3(0.04, 0.04, 0.04);
        return mat;
    };

    // Load the level and keep only the level meshes visible (props are rebuilt procedurally).
    const result = await SceneLoader.ImportMeshAsync("", LEVEL_BASE, "levelTest.glb", scene);
    // Baked lightmap (PG #WO0H1U#165): multiplied into the level as a shadowmap, sampled on UV2,
    // intensity 3.2, with the uAng = π V-flip.
    const lightmap = new Texture(LEVEL_BASE + "lightmap.jpg", scene);
    lightmap.uAng = Math.PI;
    lightmap.level = 3.2;
    lightmap.coordinatesIndex = 1;
    for (const mesh of result.meshes) {
        const name = mesh.name;
        if (name === "level" || name.startsWith("level_primitive")) {
            const pbr = (mesh as Mesh).material as PBRMaterial;
            const mat = new StandardMaterial("level", scene);
            if (pbr && pbr.albedoTexture) {
                mat.diffuseTexture = pbr.albedoTexture;
            }
            mat.specularColor = new Color3(0, 0, 0);
            mat.lightmapTexture = lightmap;
            mat.useLightmapAsShadowmap = true;
            (mesh as Mesh).material = mat;
            new PhysicsAggregate(mesh as Mesh, PhysicsShapeType.MESH, { mass: 0 }, scene);
        } else if (name.startsWith("Cube")) {
            mesh.setEnabled(false);
        }
    }

    // Decorative box pyramid (glTF scenery cubes). Dynamic (mass 0.1) so the character pushes them
    // and onTriggerCollisionObservable fires — both in interactive and auto-test mode.
    const boxMass = 0.1;
    CUBES.forEach((p, i) => {
        const box = MeshBuilder.CreateBox("cube" + i, { size: 1 }, scene);
        box.position.copyFrom(p);
        box.material = makeMaterial(CUBE_COLOR);
        new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: boxMass }, scene);
    });

    // Hinged swinging plane (glTF Cube.007 fixed anchor + Cube.006 plane), joined by a hinge
    // constraint. Dynamic + non-deterministic, so it is built only in interactive mode — skipped
    // in auto-test to keep the parity capture deterministic.
    if (!autoTest) {
        const fixedMesh = MeshBuilder.CreateBox("fixedBox", { size: 2 }, scene);
        fixedMesh.position.set(19.0498, -0.4281, -11.6688);
        // glTF Cube.007 rotation (0,0,√½,√½) reflected for the -X world flip → (0,0,-√½,√½).
        fixedMesh.rotationQuaternion = new Quaternion(0, 0, -0.70710678, 0.70710678);
        fixedMesh.scaling.set(0.2782, 0.0667, 0.6894);
        fixedMesh.material = makeMaterial(CUBE_COLOR);
        const fixed = new PhysicsAggregate(fixedMesh, PhysicsShapeType.BOX, { mass: 0 }, scene);

        const planeMesh = MeshBuilder.CreateBox("planeBox", { size: 2 }, scene);
        // Author the plane at the hinge's settled equilibrium so it starts immobile yet stays an
        // active, properly-aligned hinge the player can still knock. (glTF authoring pose
        // 19.1198,-0.0508,-11.6786 / quat -0.5,-0.5,0.5,0.5 would visibly swing down to settle.)
        planeMesh.position.set(19.045139, 0.071943, -11.6688);
        planeMesh.rotationQuaternion = new Quaternion(0.713661, 0.700491, 0, 0);
        planeMesh.scaling.set(0.03, 3, 1);
        planeMesh.material = makeMaterial(CUBE_COLOR);
        const plane = new PhysicsAggregate(planeMesh, PhysicsShapeType.BOX, { mass: 0.1 }, scene);

        // Pivots have their X negated vs the playground because the bodies live in the -X reflected
        // world (anchors then coincide as in PG #WO0H1U#165). Axes have X=0 so are unchanged.
        const joint = new HingeConstraint(new Vector3(-0.75, 0, 0), new Vector3(0.25, 0, 0), new Vector3(0, 0, -1), new Vector3(0, 0, 1), scene);
        fixed.body.addConstraint(plane.body, joint);
    }

    // Character: display capsule + physics character controller.
    const displayCapsule = MeshBuilder.CreateCapsule("CharacterDisplay", { height: CAPSULE_HEIGHT, radius: CAPSULE_RADIUS }, scene);
    displayCapsule.material = makeMaterial(new Color3(0.85, 0.55, 0.2));
    displayCapsule.position.copyFrom(CHARACTER_START);

    const character = new PhysicsCharacterController(CHARACTER_START.clone(), { capsuleHeight: CAPSULE_HEIGHT, capsuleRadius: CAPSULE_RADIUS }, scene);

    // Record character→collider contacts (PG #WO0H1U#169). Logged like the playground and (in
    // auto-test) accumulated for the parity spec.
    const collisions: { collider: string; impulsePosition: { x: number; y: number; z: number } }[] = [];
    character.onTriggerCollisionObservable.add((event) => {
        const pos = event.impulsePosition;
        console.log(`Character collision : ${event.collider.transformNode.name} at ${pos.toString()}`);
        if (autoTest) {
            collisions.push({ collider: event.collider.transformNode.name, impulsePosition: { x: round(pos.x), y: round(pos.y), z: round(pos.z) } });
        }
    });
    // Explicit look-at target so the camera-space movement + follow math matches the Lite scene
    // bit-for-bit (independent of FreeCamera's internal getTarget()).
    const camTarget = CHARACTER_START.clone();

    // Auto parity test: walk forward a fixed number of steps then freeze + capture. Interactive
    // mode: idle until keyboard input drives the character, and keep rendering.
    const inputDirection = (autoTest ? AUTOTEST_INPUT : IDLE_INPUT).clone();
    if (!autoTest) {
        window.addEventListener("keydown", (e) => {
            if (e.key === "w" || e.key === "ArrowUp") inputDirection.z = 1;
            else if (e.key === "s" || e.key === "ArrowDown") inputDirection.z = -1;
            else if (e.key === "a" || e.key === "ArrowLeft") inputDirection.x = -1;
            else if (e.key === "d" || e.key === "ArrowRight") inputDirection.x = 1;
            else if (e.key === " ") inputDirection.y = 1;
        });
        window.addEventListener("keyup", (e) => {
            if (e.key === "w" || e.key === "s" || e.key === "ArrowUp" || e.key === "ArrowDown") inputDirection.z = 0;
            else if (e.key === "a" || e.key === "d" || e.key === "ArrowLeft" || e.key === "ArrowRight") inputDirection.x = 0;
            else if (e.key === " ") inputDirection.y = -0.5;
        });
    }

    let ready = false;
    let steps = 0;
    let captureQueued = false;

    scene.onAfterPhysicsObservable.add(() => {
        const dt = 1 / PHYSICS_FPS;
        // Move the character in CAMERA space: rotate the input by the camera yaw around Y.
        const yaw = Math.atan2(camTarget.x - camera.position.x, camTarget.z - camera.position.z);
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        const s = dt * 2;
        const displacement = new Vector3(
            (inputDirection.x * cos + inputDirection.z * sin) * s,
            inputDirection.y * s,
            (-inputDirection.x * sin + inputDirection.z * cos) * s
        );
        character.moveWithCollisions(displacement);
        const p = character.getPosition();
        displayCapsule.position.copyFrom(p);

        // Camera follow (ported from the playground), matching the Lite scene's math.
        let fx = camTarget.x - camera.position.x;
        let fz = camTarget.z - camera.position.z;
        const flen = Math.hypot(fx, fz) || 1;
        fx /= flen;
        fz /= flen;
        camTarget.set(camTarget.x + (p.x - camTarget.x) * 0.1, camTarget.y + (p.y - camTarget.y) * 0.1, camTarget.z + (p.z - camTarget.z) * 0.1);
        const dist = Math.hypot(camera.position.x - p.x, camera.position.y - p.y, camera.position.z - p.z);
        const amount = (Math.min(dist - 6, 0) + Math.max(dist - 9, 0)) * 0.04;
        camera.position.set(camera.position.x + fx * amount, camera.position.y + (p.y + 2 - camera.position.y) * 0.04, camera.position.z + fz * amount);
        camera.setTarget(camTarget);

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
                engine.stopRenderLoop();
            }, 0);
        }
    });

    scene.onAfterRenderObservable.add(() => {
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
