/**
 * Antigravity Racer — arena builder (lighting + deformed track + boulders + terrain).
 *
 * Builds the whole static world ONCE per mode; `addArenaToScene` can be called
 * on more than one `SceneContext` for the same arena (Lite meshes may live in
 * several scenes at once — see `mesh-scene-registry.ts`), which is what makes
 * the 2P split-screen mode possible without duplicating geometry: both panes'
 * scenes share the same track/boulder/terrain meshes and only differ by camera.
 */

import type { EngineContext, LightBase, Mesh, SceneContext, Vec3 } from "babylon-lite";
import { addToScene, createDirectionalLight, createHemisphericLight } from "babylon-lite";

import type { RacerAssets } from "./assets.js";
import { buildTrack, addTrackToScene, type TrackData } from "./track.js";
import { createRocks, addRocksToScene, type RockField } from "./rocks.js";
import { createTerrain, addTerrainToScene } from "./terrain.js";
import { DEFAULT_CONTROL_POINTS } from "./constants.js";

export interface Arena {
    readonly track: TrackData;
    readonly rocks: RockField;
    readonly terrain: Mesh;
    readonly lights: readonly LightBase[];
    dispose(): void;
}

export function buildArena(engine: EngineContext, assets: RacerAssets, controlPoints: readonly Vec3[] = DEFAULT_CONTROL_POINTS): Arena {
    const track = buildTrack(engine, assets.trackTextures, controlPoints);
    const rocks = createRocks(assets);
    const terrain = createTerrain(engine);

    const sun = createDirectionalLight([-0.4, -0.85, -0.35], 1.1);
    sun.diffuse = [1, 0.97, 0.9];
    const ambient = createHemisphericLight([0, 1, 0], 0.55);
    ambient.diffuseColor = [0.55, 0.65, 0.9];
    ambient.groundColor = [0.08, 0.06, 0.12];

    return {
        track,
        rocks,
        terrain,
        lights: [sun, ambient],
        dispose(): void {
            track.dispose();
        },
    };
}

export function addArenaToScene(scene: SceneContext, arena: Arena): void {
    for (const light of arena.lights) {
        addToScene(scene, light);
    }
    addTrackToScene(scene, arena.track);
    addRocksToScene(scene, arena.rocks);
    addTerrainToScene(scene, arena.terrain);
}
