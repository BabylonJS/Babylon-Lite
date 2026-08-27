/**
 * Antigravity Racer — spawns a full grid of ships (human + AI) with their
 * visuals and trails, and syncs simulation state onto the visual scene graph
 * each tick. Kept separate from `simulation.ts` (pure physics) and
 * `ship-visual.ts` (pure mesh building) so `game.ts` just wires the three
 * together per race.
 */

import type { EngineContext, SceneContext } from "babylon-lite";
import { addToScene } from "babylon-lite";

import { createShipState, tickAllShips, type ShipAxes, type ShipState } from "./simulation.js";
import { createShipVisual, type ShipVisual } from "./ship-visual.js";
import { createShipTrail, type ShipTrail } from "./trail.js";
import type { TrackData } from "./track.js";
import { MAX_SPEED, SPAWN_RING_SPACING } from "./constants.js";

export interface ShipRig {
    readonly state: ShipState;
    readonly visual: ShipVisual;
    readonly trail: ShipTrail;
}

export interface Grid {
    readonly rigs: ShipRig[];
    tick(dt: number, axesForPlayer: (playerSlot: 0 | 1) => ShipAxes, simTime: number): void;
}

/** Spawn `humanCount` human-controlled ships (playerSlot 0, 1, ...) plus `aiCount` AI ships, all on
 *  `track`, and add every ship's visual + trail to each scene in `scenes` (pass 2 scenes for split-screen —
 *  see `mesh-scene-registry.ts`: a mesh may live in several scenes at once). */
export function spawnGrid(engine: EngineContext, scenes: readonly SceneContext[], track: TrackData, humanCount: number, aiCount: number): Grid {
    const total = humanCount + aiCount;
    const rigs: ShipRig[] = [];
    for (let i = 0; i < total; i++) {
        const isAI = i >= humanCount;
        const lateral = i & 1 ? 1.5 : -1.5;
        const aiSpeedFactor = isAI ? 0.82 + ((i * 6971) % 100) / 100 / 4 : 1;
        const state = createShipState(track, i * SPAWN_RING_SPACING, lateral, i, isAI, isAI ? -1 : i, aiSpeedFactor);
        const hue = isAI ? (i * 0.618033) % 1 : i === 0 ? 0.55 : 0.02;
        const visual = createShipVisual(engine, hue, !isAI);
        const trail = createShipTrail(engine, isAI ? [0.9, 0.55, 0.15] : i === 0 ? [0.25, 0.75, 1] : [1, 0.35, 0.35], state.worldPos);
        for (const scene of scenes) {
            addToSceneBoth(scene, visual, trail);
        }
        rigs.push({ state, visual, trail });
    }
    return {
        rigs,
        tick(dt, axesForPlayer, simTime): void {
            const states = rigs.map((r) => r.state);
            tickAllShips(states, track, dt, axesForPlayer, simTime);
            for (const rig of rigs) {
                syncVisual(rig);
            }
        },
    };
}

function addToSceneBoth(scene: SceneContext, visual: ShipVisual, trail: ShipTrail): void {
    addToScene(scene, visual.root);
    addToScene(scene, trail.mesh);
}

function syncVisual(rig: ShipRig): void {
    const { state, visual, trail } = rig;
    visual.root.position.set(state.worldPos.x, state.worldPos.y, state.worldPos.z);
    visual.root.rotationQuaternion.set(state.orientationQuat.x, state.orientationQuat.y, state.orientationQuat.z, state.orientationQuat.w);
    visual.tilt.position.set(state.wobble.x, state.wobble.y, state.wobble.z);
    visual.tilt.rotation.z = state.tiltZ;
    const speedRatio = Math.min(1, Math.abs(state.velocity) / MAX_SPEED);
    trail.push(state.trailEmitPoint, state.up, speedRatio);
}
