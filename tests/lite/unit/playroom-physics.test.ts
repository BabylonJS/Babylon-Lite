import { describe, expect, it, vi } from "vitest";
import { PLAYROOM_LAYOUT } from "../../../lab/lite/src/demos/playroom/layout.js";
import { installPhysicsEvents } from "../../../lab/lite/src/demos/playroom/physics.js";
import { createPuzzleRandom, expandPuzzle } from "../../../lab/lite/src/demos/playroom/puzzles.js";
import type { ModelTemplate, PlayroomState } from "../../../lab/lite/src/demos/playroom/types.js";
import type { PhysicsBody, PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok.js";
import { boxColliderForModel } from "../../../lab/lite/src/demos/playroom/world.js";

const bounds = {
    arch: { center: [0, 0.2, 0], extents: [1.12, 0.4, 0.4] },
    archCylinder: { center: [0, 0.3, 0], extents: [0.24, 0.6, 0.24] },
    archTop: { center: [0, 0.19942477345466614, 0], extents: [0.9830693602561951, 0.3988494873046875, 0.4] },
    popper: { center: [0, 0.14529758401214797, 0], extents: [0.149379163980484, 0.2905952392528448, 0.149379163980484] },
    bowlingBall: { center: [0, 0, 0], extents: [1, 1, 1] },
    bowlingPin: { center: [0, 0.663752551972866, 0], extents: [0.4063531756401062, 1.3275051194429395, 0.4063531756401062] },
    chessboard: { center: [0, 0.0260188989341259, 0], extents: [1.2000000476837158, 0.0520377978682518, 1.2000000476837158] },
    chessWhite: { center: [0, 0.12202329933643341, 0], extents: [0.11999999731779099, 0.24404659867286682, 0.11999999731779099] },
    chessBlack: { center: [0, 0.12202329933643341, 0], extents: [0.11999999731779099, 0.24404659867286682, 0.11999999731779099] },
    cube: { center: [0, 0.25, 0], extents: [0.5, 0.5, 0.5] },
    cup: { center: [0, 0.20513648092746716, 0], extents: [0.3989320993423462, 0.4102730095386505, 0.3989320993423462] },
    domino: { center: [0, 0.15000000149011612, 0], extents: [0.15000000596046448, 0.30000002086162567, 0.03750000149011612] },
    ramp: { center: [0.0570751428604126, 0.4741147816181183, 8.940696716308594e-8], extents: [2.488025426864624, 0.9482296586036682, 0.8898646235466003] },
    towerGameBlock: { center: [0, 0.14999999105930328, 0], extents: [0.4999999701976776, 0.29999998211860657, 1.4999998807907104] },
    transformedTowerGameBlock: { center: [0, -2.9802322387695312e-8, 2.2351741790771484e-8], extents: [0.4999999403953552, 1.5000001788139343, 0.30000023543834686] },
} as const satisfies Record<string, ModelTemplate["collisionBounds"]>;
const templates = Object.fromEntries(Object.entries(bounds).map(([model, collisionBounds]) => [model, { collisionBounds }]));

describe("The Playroom source physics description", () => {
    it("retains explicit source boxes instead of replacing them with automatic bounds", () => {
        expect(boxColliderForModel("domino", bounds.domino)).toEqual({ center: [0, 0.16, 0], extents: [0.176, 0.32, 0.042] });
        expect(boxColliderForModel("transformedTowerGameBlock", bounds.transformedTowerGameBlock)).toEqual({
            center: [0, 0, 0],
            extents: [0.5, 1.5, 0.3],
        });
        expect(boxColliderForModel("cube", bounds.cube)).toBe(bounds.cube);
    });

    it("expands the pinned source shape families and mass/material values", () => {
        const random = createPuzzleRandom(0x504c4159);
        const batches = PLAYROOM_LAYOUT.flatMap((entry) => expandPuzzle(entry, random, templates));
        expect(batches).toHaveLength(135);
        expect(batches.reduce((sum, batch) => sum + batch.matrices.length / 16, 0)).toBe(1955);
        expect(new Set(batches.filter((batch) => batch.model === "cup").map((batch) => `${batch.shape}/${batch.mass}/${batch.friction}/${batch.restitution}`))).toEqual(
            new Set(["convex/0.004000000000000001/1/0"])
        );
        expect(batches.find((batch) => batch.model === "bowlingBall")).toMatchObject({ shape: "sphere", mass: 1.6000000000000003, friction: 0.9, restitution: 0 });
        expect(batches.find((batch) => batch.model === "ramp")).toMatchObject({ shape: "mesh", mass: 0.8000000000000002, friction: 0.9, restitution: 0 });
        expect(batches.find((batch) => batch.model === "archCylinder")).toMatchObject({ shape: "cylinder", mass: 0.008000000000000002, friction: 0.2, restitution: 0.3 });
        expect(batches.find((batch) => batch.model === "arch")).toMatchObject({ shape: "arch" });
    });

    it("does not read native velocities when every matching sound is already voice-gated", () => {
        const memory = new ArrayBuffer(256);
        const event = new Int32Array(memory, 16);
        event[0] = 1;
        event[2] = 1;
        event[18] = 2;
        const getLinearVelocity = vi.fn(() => [0, [3, 2, 1]]);
        const hknp = {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_Body_SetEventMask: vi.fn(),
            HP_World_GetCollisionEvents: vi.fn(() => [0, 16]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
            HP_Body_GetLinearVelocity: getLinearVelocity,
        };
        const bodies: PhysicsBody[] = [];
        const physics = {
            _hknp: hknp,
            _hkWorld: ["world"],
            _bodies: bodies,
        } as unknown as PhysicsWorld;
        const node = { position: { x: 0, y: 0, z: 0 }, rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 } };
        const groundBody = { _hkBody: [1], _world: physics, node, motionType: 0 } as unknown as PhysicsBody;
        const projectileBody = { _hkBody: [2], _world: physics, node, motionType: 2 } as unknown as PhysicsBody;
        bodies.push(groundBody, projectileBody);
        const ground = { id: 1, body: groundBody, mesh: node, family: "ground", mass: 0, audioTags: ["ground"], scored: new Set<number>() };
        const projectile = { id: 2, body: projectileBody, mesh: node, family: "ragdoll", mass: 1, audioTags: ["projectile"], scored: new Set<number>() };
        const state = {
            physics,
            world: {
                records: [ground, projectile],
                bodiesByObject: new Map([
                    [groundBody, ground],
                    [projectileBody, projectile],
                ]),
            },
            audio: {
                status: "ready",
                voices: new Set(Array.from({ length: 8 }, () => ({}))),
                projectileFlying: true,
                contactLastPlayMs: new Map(),
                contactPairTimes: new Map(),
            },
            scorePaused: true,
            poppersArmed: false,
            disposed: false,
        } as unknown as PlayroomState;

        installPhysicsEvents(state);
        physics._afterStep![0]!(1 / 60);

        expect(getLinearVelocity).not.toHaveBeenCalled();
    });
});
