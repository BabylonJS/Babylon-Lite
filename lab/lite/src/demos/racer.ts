/**
 * Racer — Babylon Lite demo.
 *
 * A clean-room port of Kenney's "Starter Kit Racing" (originally a Godot 4.6
 * project, MIT code / CC0 assets — https://github.com/KenneyNL/Starter-Kit-Racing).
 * Drive a Kenney car around a simple tiled loop with arcade controls: the body
 * leans into turns, the wheels roll and steer, and a fixed-angle chase camera
 * eases behind you and zooms out with speed. All gameplay logic is a fresh
 * TypeScript reimplementation of the kit's GDScript; only the CC0 art is reused.
 *
 * Controls:  W / ↑ accelerate · S / ↓ brake+reverse · A D / ← → steer
 */

import HavokPhysics from "@babylonjs/havok";
import {
    AcesToneMapping,
    addToScene,
    createCsmDirectionalShadowGenerator,
    createEngine,
    createHavokWorld,
    createSceneContext,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setFog,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";

import { buildBarriers, buildBumpColliders, buildGroundCollider, createCarBall } from "./racer/physics.js";
import { RacerAudio } from "./racer/audio.js";
import { buildLighting } from "./racer/lighting.js";
import { DriftSmoke, type EmitPoint } from "./racer/smoke.js";
import { SkidMarks } from "./racer/skid.js";
import { buildTrack } from "./racer/track.js";
import { CameraRig } from "./racer/camera.js";
import { demoAssetUrl } from "./demo-asset-url.js";
import { VehicleController } from "./racer/vehicle.js";
import { VEHICLES, VehicleGarage } from "./racer/vehicles.js";
import { RacerInput } from "./racer/input.js";
import { RaceTimer, startCountdown } from "./racer/race.js";
import { SpeedLines } from "./racer/speed-lines.js";
import { Minimap } from "./racer/minimap.js";

// Rear-wheel emit points for the drift smoke, relative to the car center.
const SMOKE_REAR = 1.2; // distance behind the car center
const SMOKE_HALF = 0.6; // half the wheel track (left/right)
const SMOKE_Y = 0.25; // just above the road

/** Build the top-of-screen vehicle selector bar; returns a function to highlight the active one. */
function buildVehicleSelector(names: readonly string[], onSelect: (index: number) => void): (active: number) => void {
    const bar = document.createElement("div");
    bar.className = "racer-vehicle-selector";
    bar.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:10;font:600 13px system-ui,sans-serif;";
    const buttons = names.map((name, i) => {
        const button = document.createElement("button");
        button.textContent = name;
        button.style.cssText = "padding:6px 12px;border:0;border-radius:8px;cursor:pointer;background:rgba(0,0,0,0.45);color:#fff;backdrop-filter:blur(3px);";
        button.addEventListener("click", () => onSelect(i));
        bar.appendChild(button);
        return button;
    });
    document.body.appendChild(bar);
    return (active: number): void => {
        buttons.forEach((button, i) => {
            const on = i === active;
            button.style.background = on ? "rgba(255,210,127,0.92)" : "rgba(0,0,0,0.45)";
            button.style.color = on ? "#1a1a1a" : "#fff";
        });
    };
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.tabIndex = 0;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.62, g: 0.8, b: 0.92, a: 1.0 };
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMapping = AcesToneMapping;
    scene.imageProcessing.exposure = 1.2;
    // Subtle horizon haze (exp2), tinted to the sky so distant grass fades out (must precede registerScene).
    setFog(scene, { mode: 2, density: 0.006, start: 0, end: 0, color: [0.62, 0.8, 0.92] });

    // Physics world (Havok) — drives the car's dynamic ball and contains it within the barriers.
    const hknp = await HavokPhysics({ locateFile: () => demoAssetUrl("./HavokPhysics.wasm", import.meta.url) });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.81, z: 0 });

    // Lighting + shadows.
    const lighting = buildLighting();
    for (const light of lighting.lights) {
        addToScene(scene, light);
    }
    const shadowGen = createCsmDirectionalShadowGenerator(engine, lighting.sun, {
        mapSize: 2048,
        numCascades: 4,
        lambda: 0.6,
        cascadeBlendPercentage: 0.15,
        bias: 0.00008,
    });
    lighting.sun.shadowGenerator = shadowGen;

    // Track (ground + tile loop) and the car.
    const track = await buildTrack(engine, scene);
    const garage = await VehicleGarage.load(engine, scene, (url) => demoAssetUrl(url, import.meta.url));
    const smoke = await DriftSmoke.create(engine, scene, demoAssetUrl("./racer/sprites/smoke.png", import.meta.url));
    const skidMarks = new SkidMarks(engine, scene);
    const audio = await RacerAudio.create({
        engine: demoAssetUrl("./racer/audio/engine.ogg", import.meta.url),
        engineMotorcycle: demoAssetUrl("./racer/audio/engine-motorcycle.ogg", import.meta.url),
        skid: demoAssetUrl("./racer/audio/skid.ogg", import.meta.url),
        impact: demoAssetUrl("./racer/audio/impact.ogg", import.meta.url),
    });

    // Shadows: the visible car + track props cast onto the ground and road.
    track.ground.receiveShadows = true;
    for (const mesh of track.meshes) {
        mesh.receiveShadows = true;
    }
    const updateShadowCasters = (): void => setShadowTaskCasterMeshes(shadowGen, [...garage.current.meshes, ...track.meshes]);
    updateShadowCasters();

    // Controllers.
    const controller = new VehicleController(garage.current, track.spawn.x, track.spawn.z, track.spawn.heading);
    const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const camera = new CameraRig(scene, controller.position, controller.forward, touchDevice ? "Cinematic" : "Chase");
    const input = new RacerInput(canvas);

    // Physics containment: static barrier colliders + a dynamic ball the car rides on.
    buildBarriers(engine, scene, world, track.walls);
    buildGroundCollider(engine, scene, world);
    buildBumpColliders(engine, scene, world, track.bumpColliders);
    controller.ball = createCarBall(engine, scene, world, track.spawn.x, track.spawn.z);
    controller.ball.onImpact = (strength: number): void => audio.impact(strength);

    // Vehicle selection: a top bar + number keys 1–5 swap the visible car (and its engine sound).
    const setActiveButton = buildVehicleSelector(
        VEHICLES.map((v) => v.name),
        (index) => selectVehicle(index)
    );
    function selectVehicle(index: number): void {
        const { vehicle, def } = garage.select(index);
        controller.setVehicle(vehicle);
        audio.setEngine(def.motorcycle);
        updateShadowCasters();
        setActiveButton(index);
        canvas.focus();
    }
    setActiveButton(0);
    window.addEventListener("keydown", (e) => {
        const n = "12345".indexOf(e.key);
        if (n >= 0 && n < VEHICLES.length) {
            selectVehicle(n);
        } else if (e.key === "c" || e.key === "C") {
            camera.cycle();
        }
    });

    // Lap timing + HUD (finish line + checkpoints, crossed by position); held until the countdown's GO.
    const raceTimer = new RaceTimer(track.finishLine, track.checkpoints);
    let countdownActive = true;
    const speedLines = new SpeedLines();
    const minimap = new Minimap(track.path, { x: track.finishLine.cx, z: track.finishLine.cz });

    // Drive the car with real (clamped) frame time so its speed is frame-rate independent.
    onBeforeRender(scene, (deltaMs: number) => {
        const dt = Math.min(deltaMs / 1000, 0.05);
        const axes = countdownActive ? { steer: 0, throttle: 0 } : input.read();
        controller.tick(dt, axes);
        const p = controller.position;
        const f = controller.forward;
        const speed = controller.speed;
        const driftIntensity = controller.driftIntensity;
        camera.tick(dt, p, speed, f);
        speedLines.update(dt, speed);
        audio.update(dt, speed, axes.throttle, driftIntensity);
        raceTimer.update(p.x, p.z, performance.now());

        // Drift smoke + skid marks from the rear wheels: two for the cars, one centred for the motorcycle.
        const bx = p.x - f.x * SMOKE_REAR;
        const bz = p.z - f.z * SMOKE_REAR;
        const wheels: EmitPoint[] = controller.isMotorcycle
            ? [{ x: bx, y: SMOKE_Y, z: bz }]
            : [
                  { x: bx - f.z * SMOKE_HALF, y: SMOKE_Y, z: bz + f.x * SMOKE_HALF },
                  { x: bx + f.z * SMOKE_HALF, y: SMOKE_Y, z: bz - f.x * SMOKE_HALF },
              ];
        smoke.update(dt, driftIntensity, wheels);
        skidMarks.update(dt, driftIntensity, wheels, f.x, f.z);
        minimap.update(p.x, p.z, f.x, f.z);
    });

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);

    canvas.dataset.ready = "true";
    canvas.focus();

    // 3-2-1-GO: hold the car until GO, then start the lap clock.
    startCountdown(() => {
        countdownActive = false;
        raceTimer.arm(performance.now());
        canvas.focus();
    });
}

main().catch((err: unknown) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && (err as Error).stack ? (err as Error).stack : ""}`;
    document.body.appendChild(pre);
});
