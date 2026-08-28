/**
 * Parity tests for the Antigravity Racer simulation and cameras.
 *
 * Every expectation here is a statement about the SOURCE PLAYGROUND (snippet
 * WVPVWL#0), in its original per-tick units — see
 * `docs/lite/architecture/demo-antigravity-racer.md`.
 *
 * The demo's `babylon-lite` imports resolve to the REAL package source (the lab's
 * `node_modules/babylon-lite` is a workspace symlink, so a `vi.mock` written from
 * `tests/` never matches it). That is what we want here: everything under test is
 * pure math plus `createBankedFreeCamera`, which touches no device.
 */

import { describe, expect, it, vi } from "vitest";

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

interface TrackFrame {
    pos: Vec3;
    dir: Vec3;
    up: Vec3;
    right: Vec3;
}

interface ShipControls {
    left: boolean;
    right: boolean;
    accelerate: boolean;
}

interface ShipState {
    index: number;
    isAI: boolean;
    playerSlot: number;
    worldPos: Vec3;
    velocity: number;
    velocityDirection: Vec3;
    velocityDirectionEffective: Vec3;
    up: Vec3;
    meshRight: Vec3;
    meshForward: Vec3;
    rotYSpeed: number;
    currentSegment: number;
    lastBonusSegment: number;
    tiltZ: number;
    wobble: Vec3;
    trailIntensity: number;
    cameraOffsetIndex: number;
}

interface TrackData {
    frames: TrackFrame[];
    boostRight: boolean[];
    boostLeft: boolean[];
}

interface CameraLike {
    position: Vec3;
    target: Vec3;
    upVector: Vec3;
    fov: number;
    farPlane: number;
}

// Non-literal imports so the tests TypeScript project does not recursively typecheck the demo.
const trackPath = "../../../lab/lite/src/demos/antigravity-racer/track.js";
const simulationPath = "../../../lab/lite/src/demos/antigravity-racer/simulation.js";
const constantsPath = "../../../lab/lite/src/demos/antigravity-racer/constants.js";
const cameraPath = "../../../lab/lite/src/demos/antigravity-racer/camera-rig.js";

const { buildTrackFrames, frameLocalCoords, frameToWorld } = (await import(trackPath)) as {
    buildTrackFrames: (points: readonly Vec3[]) => { frames: TrackFrame[]; curveRatios: number[] };
    frameLocalCoords: (frame: TrackFrame, worldPos: Vec3) => Vec3;
    frameToWorld: (frame: TrackFrame, local: Vec3) => Vec3;
};
const { createShipState, tickShip, tickAllShips, shipEmitterPoint, shipSpeedRatio } = (await import(simulationPath)) as {
    createShipState: (track: TrackData, spawnSegment: number, lateral: number, index: number, isAI: boolean, playerSlot: number) => ShipState;
    tickShip: (ship: ShipState, ships: readonly ShipState[], track: TrackData, controls: ShipControls, simTime: number) => void;
    tickAllShips: (ships: readonly ShipState[], track: TrackData, controlsFor: (slot: 0 | 1) => ShipControls, simTime: number) => void;
    shipEmitterPoint: (ship: ShipState) => Vec3;
    shipSpeedRatio: (ship: ShipState) => number;
};
const constants = (await import(constantsPath)) as Record<string, number> & {
    DEFAULT_CONTROL_POINTS: readonly Vec3[];
    CHASE_CAMERA_OFFSETS: readonly Vec3[];
    CHASE_TARGET_LOCAL: Vec3;
    TRAIL_EMITTER_LOCAL: Vec3;
};
const { ChaseCamera, DemoCamera } = (await import(cameraPath)) as {
    ChaseCamera: new (scene: unknown, ship: ShipState) => { camera: CameraLike; tick(): void; cycleOffset(): void };
    DemoCamera: new (scene: unknown, track: TrackData, ships: readonly ShipState[]) => { camera: CameraLike; tick(): void };
};

const NEUTRAL: ShipControls = { left: false, right: false, accelerate: false };

function snapshot(v: Vec3): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
}

function makeTrack(): TrackData {
    const { frames } = buildTrackFrames(constants.DEFAULT_CONTROL_POINTS);
    return { frames, boostRight: frames.map((_f, i) => i % 32 === 2), boostLeft: frames.map((_f, i) => i % 32 === 6) };
}

/** A perfectly straight, unbanked track — deterministic ground truth for the local-space rules. */
function straightTrack(count = 64): TrackData {
    const frames: TrackFrame[] = [];
    for (let i = 0; i < count; i++) {
        frames.push({ pos: { x: 0, y: 0, z: i }, dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 } });
    }
    return { frames, boostRight: frames.map(() => false), boostLeft: frames.map(() => false) };
}

const track = makeTrack();

describe("original per-tick constants", () => {
    it("keeps the playground's units", () => {
        expect(constants.MAX_SPEED).toBe(0.7);
        expect(constants.MAX_ACCEL).toBe(0.004);
        expect(constants.VELOCITY_DRAG).toBe(0.99);
        expect(constants.WALL_HIT_DRAG).toBe(0.99);
        expect(constants.BOOST_SPEED_KICK).toBe(0.3);
        expect(constants.BOOST_DEBOUNCE_SEGMENTS).toBe(10);
        expect(constants.MAX_STEER_TILT).toBe(0.8);
        expect(constants.MAX_YAW_RATE).toBe(0.05);
        expect(constants.UP_BLEND).toBe(0.1);
        expect(constants.YAW_BLEND).toBe(0.1);
        expect(constants.TILT_BLEND).toBe(0.1);
        expect(constants.INERTIA_SPEED_TERM).toBe(0.98);
        expect(constants.FLOOR_DAMP).toBe(0.45);
        expect(constants.CEIL_DAMP).toBe(0.9);
        expect(constants.WALL_BASE_SLOPE).toBe(2.5);
        expect(constants.TICK_TIME).toBe(0.0166);
        expect(constants.AI_AIM_LOOKAHEAD).toBe(6);
        expect(constants.AI_AVOID_LIMIT).toBe(6);
        expect(constants.AI_AVOID_TOLERANCE).toBe(0.1);
        expect(constants.TOTAL_SHIP_COUNT).toBe(8);
        expect(constants.SPAWN_LATERAL).toBe(1.5);
        expect(constants.SHIP_MODEL_YAW).toBeCloseTo(Math.PI, 12);
    });
});

describe("vertical adhesion", () => {
    it("writes the damped Y back into the world position (0.45 below, 0.9 above)", () => {
        for (const [offset, damp] of [
            [-2, 0.45],
            [2, 0.9],
        ] as const) {
            const straight = straightTrack();
            const ship = createShipState(straight, 8, 0, 0, false, 0);
            ship.worldPos = frameToWorld(straight.frames[8]!, { x: 0, y: offset, z: 0 });
            tickShip(ship, [ship], straight, NEUTRAL, 0);
            expect(frameLocalCoords(straight.frames[ship.currentSegment]!, ship.worldPos).y).toBeCloseTo(offset * damp, 10);
        }
    });

    it("applies the same damping on the real track", () => {
        const ship = createShipState(track, 40, 0, 0, false, 0);
        ship.worldPos = frameToWorld(track.frames[40]!, { x: 0, y: -2, z: 0 });
        tickShip(ship, [ship], track, NEUTRAL, 0);
        expect(frameLocalCoords(track.frames[ship.currentSegment]!, ship.worldPos).y).toBeCloseTo(-0.9, 4);
    });
});

describe("wall clamping", () => {
    it("clamps to 2.5 + dampedY and applies the extra 0.99 drag", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 4, 0, 0, false, 0);
        ship.worldPos = frameToWorld(straight.frames[4]!, { x: 9, y: 0, z: 0 });
        ship.velocity = 0.5;
        tickShip(ship, [ship], straight, NEUTRAL, 0);
        expect(ship.velocity).toBeCloseTo(0.5 * 0.99 * 0.99, 12);
        expect(frameLocalCoords(straight.frames[ship.currentSegment]!, ship.worldPos).x).toBeCloseTo(2.5, 6);
    });

    it("widens the wall with the damped height", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 4, 0, 0, false, 0);
        ship.worldPos = frameToWorld(straight.frames[4]!, { x: 9, y: 2, z: 0 });
        tickShip(ship, [ship], straight, NEUTRAL, 0);
        // wallSlope = 2.5 + (2 * 0.9)
        expect(frameLocalCoords(straight.frames[ship.currentSegment]!, ship.worldPos).x).toBeCloseTo(4.3, 6);
    });
});

describe("up interpolation", () => {
    it("extrapolates with the RAW, unclamped local z", () => {
        // Two frames whose up vectors differ, so any clamping of z is observable.
        const frames: TrackFrame[] = [
            { pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 } },
            { pos: { x: 0, y: 0, z: 1 }, dir: { x: 0, y: 0, z: 1 }, up: { x: 1, y: 0, z: 0 }, right: { x: 0, y: -1, z: 0 } },
        ];
        const fake: TrackData = { frames, boostRight: [false, false], boostLeft: [false, false] };
        const ship = createShipState(fake, 0, 0, 0, false, 0);
        ship.worldPos = { x: 0, y: 0, z: -4 };
        tickShip(ship, [ship], fake, NEUTRAL, 0);
        // lerp(up0, up1, -4) = (-4, 5, 0), blended 10% into (0, 1, 0). A clamped z would leave up = (0, 1, 0).
        expect(ship.up.x).toBeLessThan(-0.2);
    });
});

describe("acceleration, drag and boost", () => {
    it("matches the original trace from a standing start", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        const accelerate: ShipControls = { left: false, right: false, accelerate: true };
        let expected = 0;
        for (let i = 0; i < 6; i++) {
            expected = (expected + 0.004 * (1 - Math.min(1, expected / 0.7))) * 0.99;
            tickShip(ship, [ship], straight, accelerate, i * 0.0166);
            expect(ship.velocity).toBeCloseTo(expected, 12);
        }
    });

    it("drags every tick even when coasting", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        ship.velocity = 0.5;
        tickShip(ship, [ship], straight, NEUTRAL, 0);
        expect(ship.velocity).toBeCloseTo(0.5 * 0.99, 12);
    });

    it("adds exactly +0.3 on a boost pad and debounces for 10 segments", () => {
        const seg = 34; // 34 % 32 === 2 → a right-hand pad
        const ship = createShipState(track, seg, 0, 0, false, 0);
        ship.worldPos = frameToWorld(track.frames[seg]!, { x: 2, y: 0, z: 0 });
        ship.velocity = 0.1;
        tickShip(ship, [ship], track, NEUTRAL, 0);
        expect(ship.velocity).toBeCloseTo((0.1 + 0.3) * 0.99, 10);
        expect(ship.lastBonusSegment).toBe(seg);

        // Re-entering the same pad immediately must not re-trigger.
        ship.worldPos = frameToWorld(track.frames[seg]!, { x: 2, y: 0, z: 0 });
        ship.currentSegment = seg;
        const before = ship.velocity;
        tickShip(ship, [ship], track, NEUTRAL, 0);
        expect(ship.velocity).toBeCloseTo(before * 0.99, 10);
    });

    it("only boosts past |x| > 1 on the matching side", () => {
        const seg = 34;
        const ship = createShipState(track, seg, 0, 0, false, 0);
        ship.worldPos = frameToWorld(track.frames[seg]!, { x: -2, y: 0, z: 0 });
        ship.velocity = 0.1;
        tickShip(ship, [ship], track, NEUTRAL, 0);
        expect(ship.velocity).toBeCloseTo(0.1 * 0.99, 10);
    });

    it("seeds lastBonusSegment far away so the first pad always fires", () => {
        expect(createShipState(track, 0, 0, 0, false, 0).lastBonusSegment).toBe(99999);
    });
});

describe("drift inertia", () => {
    it("leaves the effective direction un-normalized so corners cost speed", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        ship.velocity = 0.7;
        ship.velocityDirectionEffective = { x: 0, y: 0, z: -1 };
        tickShip(ship, [ship], straight, NEUTRAL, 0);
        const e = ship.velocityDirectionEffective;
        expect(Math.hypot(e.x, e.y, e.z)).toBeLessThan(0.99);
    });

    it("blends with weight 1 - speedRatio * 0.98", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        ship.velocity = 0.7;
        expect(shipSpeedRatio(ship)).toBe(1);
        ship.velocityDirectionEffective = { x: 1, y: 0, z: 1 };
        tickShip(ship, [ship], straight, NEUTRAL, 0);
        // weight = 1 - 1 * 0.98 = 0.02, so 98% of the 1-unit lateral offset survives.
        expect(ship.velocityDirectionEffective.x).toBeCloseTo(0.98, 12);
    });
});

describe("human steering", () => {
    it("is binary and lets right win when both are held", () => {
        const straight = straightTrack();
        const both = createShipState(straight, 0, 0, 0, false, 0);
        const rightOnly = createShipState(straight, 0, 0, 0, false, 0);
        tickShip(both, [both], straight, { left: true, right: true, accelerate: false }, 0);
        tickShip(rightOnly, [rightOnly], straight, { left: false, right: true, accelerate: false }, 0);
        expect(both.rotYSpeed).toBeCloseTo(rightOnly.rotYSpeed, 12);
        expect(both.rotYSpeed).toBeCloseTo(0.05 * 0.1, 12);
        expect(both.tiltZ).toBeCloseTo(rightOnly.tiltZ, 12);
    });

    it("yaws left when only left is held", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        tickShip(ship, [ship], straight, { left: true, right: false, accelerate: false }, 0);
        expect(ship.rotYSpeed).toBeCloseTo(-0.05 * 0.1, 12);
    });

    it("does not accelerate without the accelerate control", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        tickShip(ship, [ship], straight, { left: false, right: true, accelerate: false }, 0);
        expect(ship.velocity).toBe(0);
    });
});

describe("the starting grid", () => {
    it("spawns eight ships on consecutive segments 0..7, alternating +/-1.5", () => {
        const ships: ShipState[] = [];
        for (let i = 0; i < 8; i++) {
            ships.push(createShipState(track, i, i & 1 ? 1.5 : -1.5, i, i >= 1, i >= 1 ? -1 : i));
        }
        expect(ships.map((s) => s.currentSegment)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        for (let i = 0; i < 8; i++) {
            expect(frameLocalCoords(track.frames[i]!, ships[i]!.worldPos).x).toBeCloseTo(i & 1 ? 1.5 : -1.5, 6);
        }
        // Consecutive spawns put every ship inside its neighbours' 6-segment avoidance window.
        expect((ships[5]!.currentSegment - ships[0]!.currentSegment + 256) % 256).toBeLessThan(6);
    });

    it("gives every ship the same tuning (no AI speed variance)", () => {
        const straight = straightTrack();
        const ships = [0, 1].map((i) => createShipState(straight, 0, 0, i, true, -1));
        for (let t = 0; t < 30; t++) {
            tickAllShips(ships, straight, () => NEUTRAL, t * 0.0166);
        }
        expect(ships[0]!.velocity).toBeCloseTo(ships[1]!.velocity, 12);
    });
});

describe("AI steering", () => {
    it("always accelerates", () => {
        const straight = straightTrack();
        const ai = createShipState(straight, 0, 0, 0, true, -1);
        tickShip(ai, [ai], straight, NEUTRAL, 0);
        expect(ai.velocity).toBeCloseTo(0.004 * 0.99, 12);
    });

    it("steers straight down an empty straight track", () => {
        const straight = straightTrack();
        const ai = createShipState(straight, 0, 0, 0, true, -1);
        tickShip(ai, [ai], straight, NEUTRAL, 0);
        expect(ai.rotYSpeed).toBeCloseTo(0, 12);
    });

    it("swings away from a ship directly ahead inside the six-segment window", () => {
        const straight = straightTrack();
        const solo = createShipState(straight, 0, 0, 0, true, -1);
        const chaser = createShipState(straight, 0, 0, 0, true, -1);
        const blocker = createShipState(straight, 3, 0, 3, true, -1);
        tickShip(solo, [solo], straight, NEUTRAL, 0);
        tickShip(chaser, [chaser, blocker], straight, NEUTRAL, 0);
        // aim dot == avoid dot == 0 → inside the 0.1 tolerance → the aim is pushed to -0.1.
        expect(solo.rotYSpeed).toBeCloseTo(0, 12);
        expect(chaser.rotYSpeed).toBeCloseTo(0.05 * -0.1 * 0.1, 12);
    });

    it("ignores ships more than six segments ahead", () => {
        const straight = straightTrack();
        const solo = createShipState(straight, 0, 0, 0, true, -1);
        const withFar = createShipState(straight, 0, 0, 0, true, -1);
        const far = createShipState(straight, 40, 0, 40, true, -1);
        tickShip(solo, [solo], straight, NEUTRAL, 0);
        tickShip(withFar, [withFar, far], straight, NEUTRAL, 0);
        expect(withFar.rotYSpeed).toBeCloseTo(solo.rotYSpeed, 12);
    });
});

describe("the trail emitter", () => {
    it("equals TransformCoordinates((0.05, 0, 0.85), ShipTransform.worldMatrix)", () => {
        expect(constants.TRAIL_EMITTER_LOCAL).toEqual({ x: 0.05, y: 0, z: 0.85 });
        const ship = createShipState(track, 12, 0, 3, false, 0);
        for (let t = 0; t < 7; t++) {
            tickShip(ship, [ship], track, { left: false, right: true, accelerate: true }, t * 0.0166);
            const folded = shipEmitterPoint(ship);
            const reference = referenceEmitter(ship);
            expect(folded.x).toBeCloseTo(reference.x, 12);
            expect(folded.y).toBeCloseTo(reference.y, 12);
            expect(folded.z).toBeCloseTo(reference.z, 12);
        }
    });

    it("publishes the PRE-acceleration speed ratio as the trail intensity", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 0, 0, 0, false, 0);
        ship.velocity = 0.35;
        tickShip(ship, [ship], straight, { left: false, right: false, accelerate: true }, 0);
        expect(ship.trailIntensity).toBeCloseTo(0.5, 12);
        expect(ship.trailIntensity).not.toBeCloseTo(shipSpeedRatio(ship), 6);
    });
});

/** Full matrix composition of the playground's ShipMesh · ShipTransform · (0.05, 0, 0.85). */
function referenceEmitter(ship: ShipState): Vec3 {
    // ShipTransform local rotation is Babylon yaw-pitch-roll (0, PI, tiltZ) → Ry(PI) · Rz(tiltZ).
    const cz = Math.cos(ship.tiltZ);
    const sz = Math.sin(ship.tiltZ);
    const p = constants.TRAIL_EMITTER_LOCAL;
    const rz = { x: p.x * cz - p.y * sz, y: p.x * sz + p.y * cz, z: p.z };
    const ry = { x: -rz.x, y: rz.y, z: -rz.z };
    const local = { x: ry.x + ship.wobble.x, y: ry.y + ship.wobble.y, z: ry.z + ship.wobble.z };
    const r = ship.meshRight;
    const u = ship.up;
    const d = ship.meshForward;
    return {
        x: ship.worldPos.x + r.x * local.x + u.x * local.y + d.x * local.z,
        y: ship.worldPos.y + r.y * local.x + u.y * local.y + d.y * local.z,
        z: ship.worldPos.z + r.z * local.x + u.z * local.y + d.z * local.z,
    };
}

describe("chase camera", () => {
    it("uses the playground's offsets, look target, FOV and smoothing", () => {
        expect(constants.CHASE_CAMERA_OFFSETS).toEqual([
            { x: 0, y: 3, z: -5 },
            { x: 0, y: 2, z: -2.8 },
        ]);
        expect(constants.CHASE_TARGET_LOCAL).toEqual({ x: 0, y: 0, z: 5 });
        expect(constants.CAMERA_FOV).toBe(0.8);
        expect(constants.CAMERA_LERP_BASE).toBe(0.1);
        expect(constants.CAMERA_LERP_SPEED_TERM).toBe(0.7);

        const straight = straightTrack();
        const ship = createShipState(straight, 4, 0, 0, false, 0);
        const chase = new ChaseCamera({}, ship);
        expect(chase.camera.fov).toBe(0.8);
        expect(snapshot(chase.camera.position)).toEqual({ x: 0, y: 3, z: -1 });
        expect(snapshot(chase.camera.target)).toEqual({ x: 0, y: 0, z: 9 });
        expect(snapshot(chase.camera.upVector)).toEqual({ x: 0, y: 1, z: 0 });
    });

    it("eases position, target and up with 0.1 + speedRatio * 0.7", () => {
        const straight = straightTrack();
        const ship = createShipState(straight, 4, 0, 0, false, 0);
        const chase = new ChaseCamera({}, ship);
        chase.camera.position.y = 0;
        chase.camera.upVector.y = 0;
        ship.velocity = 0.35; // speedRatio 0.5 → k = 0.45
        chase.tick();
        expect(chase.camera.position.y).toBeCloseTo(3 * 0.45, 10);
        expect(chase.camera.upVector.y).toBeCloseTo(0.45, 10);
    });

    it("cycles between the two CameraRels offsets", () => {
        const ship = createShipState(track, 0, 0, 0, false, 0);
        const chase = new ChaseCamera({}, ship);
        expect(ship.cameraOffsetIndex).toBe(0);
        chase.cycleOffset();
        expect(ship.cameraOffsetIndex).toBe(1);
        chase.cycleOffset();
        expect(ship.cameraOffsetIndex).toBe(0);
    });
});

describe("demo camera", () => {
    it("anchors 20 segments ahead of ship 5, two units up, with a 1500 far plane", () => {
        expect(constants.DEMO_CAMERA_SHIP).toBe(5);
        expect(constants.DEMO_CAMERA_LOOKAHEAD).toBe(20);
        expect(constants.DEMO_CAMERA_UP).toBe(2);
        expect(constants.EDITOR_CAMERA_FAR).toBe(1500);

        const ships = Array.from({ length: 8 }, (_v, i) => createShipState(track, i, 0, i, true, -1));
        ships[5]!.currentSegment = 100;
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        const demo = new DemoCamera({}, track, ships);
        random.mockRestore();

        const frame = track.frames[120]!;
        // Math.random() === 0 ⇒ zero drift scale, so the camera sits exactly on the anchor.
        expect(demo.camera.position.x).toBeCloseTo(frame.pos.x + frame.up.x * 2, 10);
        expect(demo.camera.position.y).toBeCloseTo(frame.pos.y + frame.up.y * 2, 10);
        expect(demo.camera.position.z).toBeCloseTo(frame.pos.z + frame.up.z * 2, 10);
        expect(demo.camera.upVector.x).toBeCloseTo(frame.up.x, 12);
        expect(demo.camera.farPlane).toBe(1500);
        // dirFactor = -3 (0 is not > 0.5) ⇒ target = pos + dir * -9.
        expect(demo.camera.target.x).toBeCloseTo(frame.pos.x - frame.dir.x * 9, 10);
        expect(demo.camera.target.z).toBeCloseTo(frame.pos.z - frame.dir.z * 9, 10);
    });

    it("dollies with a fixed orientation between anchors", () => {
        const ships = Array.from({ length: 8 }, (_v, i) => createShipState(track, i, 0, i, true, -1));
        const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
        const demo = new DemoCamera({}, track, ships);
        const p0 = snapshot(demo.camera.position);
        const t0 = snapshot(demo.camera.target);
        demo.tick();
        random.mockRestore();
        expect(demo.camera.target.x - t0.x).toBeCloseTo(demo.camera.position.x - p0.x, 12);
        expect(demo.camera.target.y - t0.y).toBeCloseTo(demo.camera.position.y - p0.y, 12);
        expect(demo.camera.target.z - t0.z).toBeCloseTo(demo.camera.position.z - p0.z, 12);
        expect(demo.camera.position.x).not.toBeCloseTo(p0.x, 8);
    });

    it("re-anchors after 2 to 4 seconds", () => {
        const ships = Array.from({ length: 8 }, (_v, i) => createShipState(track, i, 0, i, true, -1));
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        const demo = new DemoCamera({}, track, ships);
        ships[5]!.currentSegment = 50;
        for (let i = 0; i < 120; i++) {
            demo.tick();
        }
        const beforeReanchor = snapshot(demo.camera.target);
        demo.tick(); // the 121st tick pushes the 2 s timer below zero → re-anchor
        random.mockRestore();
        const frame = track.frames[70]!;
        expect(demo.camera.target.x).toBeCloseTo(frame.pos.x - frame.dir.x * 9, 6);
        expect(demo.camera.target.x).not.toBeCloseTo(beforeReanchor.x, 3);
    });
});

// ─────────────── quatFromLookDirectionRHToRef equivalence ────────────────
describe("quatFromLookDirectionRHToRef", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quatFromLookDirectionRH: (f: Vec3, u: Vec3) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quatFromLookDirectionRHToRef: (f: Vec3, u: Vec3, out: any) => any;

    it("loads helpers", async () => {
        const mathPath = "../../../packages/babylon-lite/src/math/quat-from-look-direction-rh.js";
        const mathRefPath = "../../../packages/babylon-lite/src/math/quat-from-look-direction-rh-to-ref.js";
        quatFromLookDirectionRH = ((await import(mathPath)) as Record<string, unknown>).quatFromLookDirectionRH as typeof quatFromLookDirectionRH;
        quatFromLookDirectionRHToRef = ((await import(mathRefPath)) as Record<string, unknown>).quatFromLookDirectionRHToRef as typeof quatFromLookDirectionRHToRef;
    });

    it("produces same values as allocating variant", () => {
        const cases: [Vec3, Vec3][] = [
            [
                { x: 0, y: 0, z: 1 },
                { x: 0, y: 1, z: 0 },
            ],
            [
                { x: 1, y: 0, z: 0 },
                { x: 0, y: 1, z: 0 },
            ],
            [
                { x: 0.577, y: 0.577, z: 0.577 },
                { x: 0, y: 1, z: 0 },
            ],
        ];
        const out = { x: 0, y: 0, z: 0, w: 1 };
        for (const [f, u] of cases) {
            const expected = quatFromLookDirectionRH(f, u);
            const result = quatFromLookDirectionRHToRef(f, u, out);
            expect(result).toBe(out);
            expect(out.x).toBeCloseTo(expected.x, 12);
            expect(out.y).toBeCloseTo(expected.y, 12);
            expect(out.z).toBeCloseTo(expected.z, 12);
            expect(out.w).toBeCloseTo(expected.w, 12);
        }
    });
});

// ─────────────── Allocation contract: object identity stability ─────────
describe("allocation contract — hot-loop object identity", () => {
    it("tickShip reuses the same state-owned objects across many ticks", () => {
        const track = makeTrack();
        const ship = createShipState(track, 5, 1.5, 0, false, 0) as ShipState & {
            _emitterPoint: Vec3;
            _scratch: Record<string, Vec3>;
        };
        const refWorldPos = ship.worldPos;
        const refUp = ship.up;
        const refVelDir = ship.velocityDirection;
        const refVelDirEff = ship.velocityDirectionEffective;
        const refMeshRight = ship.meshRight;
        const refMeshForward = ship.meshForward;
        const refWobble = ship.wobble;
        const refOrientQuat = (ship as unknown as { orientationQuat: { x: number; y: number; z: number; w: number } }).orientationQuat;
        const refEmitter = ship._emitterPoint;

        const go: ShipControls = { left: false, right: true, accelerate: true };
        for (let t = 0; t < 200; t++) {
            tickShip(ship, [ship], track, go, t * 0.016);
        }

        expect(ship.worldPos).toBe(refWorldPos);
        expect(ship.up).toBe(refUp);
        expect(ship.velocityDirection).toBe(refVelDir);
        expect(ship.velocityDirectionEffective).toBe(refVelDirEff);
        expect(ship.meshRight).toBe(refMeshRight);
        expect(ship.meshForward).toBe(refMeshForward);
        expect(ship.wobble).toBe(refWobble);
        expect((ship as unknown as { orientationQuat: unknown }).orientationQuat).toBe(refOrientQuat);
        expect(ship._emitterPoint).toBe(refEmitter);

        const e1 = shipEmitterPoint(ship);
        const e2 = shipEmitterPoint(ship);
        expect(e1).toBe(e2);
        expect(e1).toBe(refEmitter);
    });
});
