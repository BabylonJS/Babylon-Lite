/**
 * Antigravity Racer — spawns a full grid of ships (human + AI) with their
 * trails, and syncs simulation state onto the instanced ship model each tick.
 * Kept separate from `simulation.ts` (pure physics) and `ship-fleet.ts` (pure
 * model instancing) so `game.ts` just wires the three together per race.
 */

import type { EngineContext, SceneContext } from "babylon-lite";
import { addToScene } from "babylon-lite";

import type { RacerAssets } from "./assets.js";
import { createShipFleet, addShipFleetToScene, type ShipFleet } from "./ship-fleet.js";
import { createShipState, tickAllShips, type ShipAxes, type ShipState } from "./simulation.js";
import { createShipTrail, type ShipTrail } from "./trail.js";
import type { TrackData } from "./track.js";
import { MAX_SPEED, SPAWN_RING_SPACING } from "./constants.js";

export interface ShipRig {
    readonly state: ShipState;
    readonly trail: ShipTrail;
}

export interface Grid {
    readonly rigs: ShipRig[];
    readonly fleet: ShipFleet;
    tick(dt: number, axesForPlayer: (playerSlot: 0 | 1) => ShipAxes, simTime: number): void;
}

/** Spawn `humanCount` human-controlled ships (playerSlot 0, 1, …) plus `aiCount` AI ships, all on
 *  `track`, and add the shared ship model + every trail to each scene in `scenes` (pass 2 scenes for
 *  split-screen — see `mesh-scene-registry.ts`: a mesh may live in several scenes at once). */
export function spawnGrid(engine: EngineContext, assets: RacerAssets, scenes: readonly SceneContext[], track: TrackData, humanCount: number, aiCount: number): Grid {
    const total = humanCount + aiCount;
    const fleet = createShipFleet(assets, total);
    const rigs: ShipRig[] = [];
    for (let i = 0; i < total; i++) {
        const isAI = i >= humanCount;
        const lateral = i & 1 ? 1.5 : -1.5;
        const aiSpeedFactor = isAI ? 0.82 + ((i * 6971) % 100) / 100 / 4 : 1;
        const state = createShipState(track, i * SPAWN_RING_SPACING, lateral, i, isAI, isAI ? -1 : i, aiSpeedFactor);
        const trail = createShipTrail(engine, isAI ? [0.9, 0.55, 0.15] : i === 0 ? [0.25, 0.75, 1] : [1, 0.35, 0.35], state.worldPos);
        rigs.push({ state, trail });
    }
    for (const scene of scenes) {
        addShipFleetToScene(scene, fleet);
        for (const rig of rigs) {
            addToScene(scene, rig.trail.mesh);
        }
    }
    // Seed every instance matrix so the first rendered frame already has the grid in place.
    for (let i = 0; i < rigs.length; i++) {
        syncVisual(fleet, i, rigs[i]!);
    }

    return {
        rigs,
        fleet,
        tick(dt, axesForPlayer, simTime): void {
            const states = rigs.map((r) => r.state);
            tickAllShips(states, track, dt, axesForPlayer, simTime);
            for (let i = 0; i < rigs.length; i++) {
                syncVisual(fleet, i, rigs[i]!);
            }
        },
    };
}

function syncVisual(fleet: ShipFleet, index: number, rig: ShipRig): void {
    const { state, trail } = rig;
    fleet.setShipTransform(index, state.worldPos, state.orientationQuat, state.wobble, state.tiltZ);
    const speedRatio = Math.min(1, Math.abs(state.velocity) / MAX_SPEED);
    trail.push(state.trailEmitPoint, state.up, speedRatio);
}
