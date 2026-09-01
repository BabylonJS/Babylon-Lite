/**
 * Antigravity Racer — the starting grid.
 *
 * Reproduces the playground's `initPlay` loop: `playerCount` ships spawned on
 * CONSECUTIVE segments `0 … playerCount-1`, alternating `±1.5` across the deck,
 * with the first `humanCount` of them player-controlled. Consecutive spawns are
 * what puts the pack inside each AI's six-segment avoidance window, so the field
 * jostles from the first tick instead of being strung out around the loop.
 *
 * Kept separate from `simulation.ts` (pure physics), `ship-fleet.ts` (model
 * instancing) and `trail.ts` (ribbon rendering) so `game.ts` just wires them.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import { addToScene } from "babylon-lite";

import type { RacerAssets } from "./assets.js";
import { createShipFleet, addShipFleetToScene, type ShipFleet } from "./ship-fleet.js";
import { createShipState, shipEmitterPoint, tickAllShips, type ShipControls, type ShipState } from "./simulation.js";
import { createShipTrail, type ShipTrail } from "./trail.js";
import type { TrackData } from "./track.js";
import { SPAWN_LATERAL } from "./constants.js";

export interface ShipRig {
    readonly state: ShipState;
    readonly trail: ShipTrail;
}

export interface Grid {
    readonly rigs: ShipRig[];
    readonly fleet: ShipFleet;
    /** Meshes that should cast shadows for this grid (the fleet's thin-instance carriers). */
    readonly casterMeshes: readonly Mesh[];
    /** Advance every ship by one fixed 60 Hz tick and push the results to the GPU. */
    tick(controlsForPlayer: (playerSlot: 0 | 1) => ShipControls, simTime: number): void;
    dispose(): void;
}

/** Spawn `humanCount` human ships (player slots 0, 1, …) plus `aiCount` AI ships and add the shared ship
 *  model + every trail to each scene in `scenes` (two scenes for split-screen — a Lite mesh may live in
 *  several scenes at once, see `mesh-scene-registry.ts`). */
export function spawnGrid(engine: EngineContext, assets: RacerAssets, scenes: readonly SceneContext[], track: TrackData, humanCount: number, aiCount: number): Grid {
    const total = humanCount + aiCount;
    const fleet = createShipFleet(assets, total);
    const rigs: ShipRig[] = [];
    for (let i = 0; i < total; i++) {
        const isAI = i >= humanCount;
        const state = createShipState(track, i, i & 1 ? SPAWN_LATERAL : -SPAWN_LATERAL, i, isAI, isAI ? -1 : i);
        rigs.push({ state, trail: createShipTrail(engine, shipEmitterPoint(state)) });
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

    const states = rigs.map((r) => r.state);
    return {
        rigs,
        fleet,
        casterMeshes: fleet.pool.meshes,
        tick(controlsForPlayer, simTime): void {
            tickAllShips(states, track, controlsForPlayer, simTime);
            for (let i = 0; i < rigs.length; i++) {
                syncVisual(fleet, i, rigs[i]!);
            }
        },
        dispose(): void {
            for (const rig of rigs) {
                rig.trail.dispose();
            }
        },
    };
}

function syncVisual(fleet: ShipFleet, index: number, rig: ShipRig): void {
    const { state, trail } = rig;
    fleet.setShipTransform(index, state.worldPos, state.orientationQuat, state.wobble, state.tiltZ);
    trail.push(shipEmitterPoint(state), state.trailIntensity);
}
