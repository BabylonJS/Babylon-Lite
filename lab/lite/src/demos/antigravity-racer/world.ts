/**
 * Antigravity Racer — the persistent world (lighting + deformed track + boulders + terrain + shadows).
 *
 * The playground has ONE world for the whole session: `createScene` builds the
 * track, the boulders, the terrain and the cascaded shadows once, and every mode
 * (`initPlay`, `initEditing`) reuses them. This module reproduces that lifetime:
 * {@link createRacerWorlds} runs exactly once per page and its resources — the
 * 600-subdivision height-mapped ground, the boulder pool, the track pieces and
 * the CSM depth arrays — live until the page goes away. The presentation layer
 * doubles the ground footprint and adds subtle blue distance fog. Mode switching only
 * builds and disposes scenes, cameras, HUD and the ship grid.
 *
 * **Why more than one "render world".** A CSM generator fits its cascades to ONE
 * camera and owns one shadow-task state, so the two split-screen panes cannot
 * share one: whichever pane rendered last would own the cascades, and the other
 * player's shadows would be wrong or missing. Each pane therefore gets its own
 * {@link RenderWorld} — its own directional light, its own CSM generator, and its
 * own track receiver/caster material pair, since that material samples the
 * cascade array of the generator it was built against. Everything that is
 * camera-independent is shared: the terrain mesh, the boulder pool, the ship
 * models and the spline source. Those are added to both panes' scenes, where Lite
 * builds a per-scene renderable that binds that pane's own generator.
 *
 * The secondary world is built on the first split-screen race and then kept, so
 * repeated 2P races reuse it. Nothing ever disposes a world: the demo has no
 * teardown below the page itself (the same lifetime `loadRacerAssets` gives the
 * models), so world resources are released when the page goes away.
 *
 * Lighting and shadows are the racer's original setup: a 0.5-intensity
 * hemispheric light aimed at (1, 1, 0), a unit directional light travelling
 * (-1, -2, -1) from (120, 50, 100), and a 1024² four-cascade
 * CSM with lambda 1, bias 0.001 and shadowMaxZ 1500 (BJS `usePercentageCloserFiltering`
 * ⇒ Lite's PCF5 receiver). The visible HDR sky is attached to each mode scene by
 * `environment.ts`. Casters are the ships, the boulders and the deformed
 * track; receivers are the terrain, the boulders and the track.
 */

import type { DirectionalLight, EngineContext, LightBase, Mesh, SceneContext, ShadowGenerator, Vec3 } from "babylon-lite";
import { addToScene, createCsmDirectionalShadowGenerator, createDirectionalLight, createHemisphericLight, createSceneContext, setShadowTaskCasterMeshes } from "babylon-lite";

import type { RacerAssets } from "./assets.js";
import { addTrackToScene, buildTrackRender, createTrackSource, type TrackData, type TrackRender } from "./track.js";
import { createRocks, addRocksToScene, type RockField } from "./rocks.js";
import { createTerrain, addTerrainToScene } from "./terrain.js";
import {
    DEFAULT_CONTROL_POINTS,
    HEMI_LIGHT_DIRECTION,
    HEMI_LIGHT_INTENSITY,
    SHADOW_BIAS,
    SHADOW_CASCADES,
    SHADOW_LAMBDA,
    SHADOW_MAP_SIZE,
    SHADOW_MAX_Z,
    SUN_DIRECTION,
    SUN_INTENSITY,
    SUN_POSITION,
} from "./constants.js";

export { SPACE_CLEAR_COLOR } from "./constants.js";

/** One pane's view of the world: its own lights, its own cascades and its own track renderer, plus
 *  the session-wide meshes it shares with the other pane. */
export interface RenderWorld {
    readonly lights: readonly LightBase[];
    readonly sun: DirectionalLight;
    readonly shadowGenerator: ShadowGenerator;
    /** This pane's track piece — receiver + caster materials bound to THIS pane's cascades. */
    readonly track: TrackRender;
    /** Shared with every other world: a boulder is camera-independent, and its per-scene renderable
     *  binds whichever generator its own scene's light carries. */
    readonly rocks: RockField;
    /** Shared with every other world (see {@link RenderWorld.rocks}). */
    readonly terrain: Mesh;
    /** This world's own casters, ships excluded (see {@link setWorldCasters}). */
    readonly baseCasters: readonly Mesh[];
}

/** The session's world resources. Built once by {@link createRacerWorlds} and never rebuilt. */
export interface RacerWorlds {
    /** The one spline source every mode and every pane reads, and the editor mutates. */
    readonly track: TrackData;
    /** The world rendered by every single-pane mode, and by pane 1 of a split-screen race. */
    readonly primary: RenderWorld;
    /** The pane-2 world, built on first use and kept for the rest of the session. */
    secondary(): RenderWorld;
    /** Every world built so far — one entry until the first split-screen race, two afterwards. */
    readonly worlds: readonly RenderWorld[];
}

function createWorldLights(): { ambient: LightBase; sun: DirectionalLight } {
    const ambient = createHemisphericLight(HEMI_LIGHT_DIRECTION, HEMI_LIGHT_INTENSITY);
    const sun = createDirectionalLight(SUN_DIRECTION, SUN_INTENSITY);
    sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
    return { ambient, sun };
}

/**
 * Build every session-lifetime world resource.
 *
 * Called once per page: it fetches the height map, builds the ground, instantiates the boulders and
 * assembles the primary world. Mode switches never come back here, so the terrain is never re-fetched
 * and no mode ever allocates a second CSM depth array.
 */
export async function createRacerWorlds(engine: EngineContext, assets: RacerAssets, controlPoints: readonly Vec3[] = DEFAULT_CONTROL_POINTS): Promise<RacerWorlds> {
    const track = createTrackSource(controlPoints);
    const rocks = createRocks(assets);
    const terrain = await createTerrain(engine);

    // Residency scene. Lite frees a mesh's shared GPU buffers when it leaves its LAST scene, and a
    // mesh disposed that way can never be added back — so every session-lifetime mesh keeps one
    // permanent membership here. It is deliberately never registered with the engine (and asks for no
    // render task), so it draws nothing and costs nothing per frame; it exists only to hold the claim
    // that lets a mode scene be disposed without taking the world down with it.
    const residency = createSceneContext(engine, { defaultRenderTask: false });
    addRocksToScene(residency, rocks);
    addTerrainToScene(residency, terrain);

    const worlds: RenderWorld[] = [];
    const buildWorld = (): RenderWorld => {
        const { ambient, sun } = createWorldLights();
        const shadowGenerator = createCsmDirectionalShadowGenerator(engine, sun, {
            mapSize: SHADOW_MAP_SIZE,
            numCascades: SHADOW_CASCADES,
            lambda: SHADOW_LAMBDA,
            bias: SHADOW_BIAS,
            shadowMaxZ: SHADOW_MAX_Z,
        });
        sun.shadowGenerator = shadowGenerator;

        const trackRender = buildTrackRender(engine, assets.trackTextures, shadowGenerator, track);
        addTrackToScene(residency, trackRender);

        const world: RenderWorld = {
            lights: [ambient, sun],
            sun,
            shadowGenerator,
            track: trackRender,
            rocks,
            terrain,
            baseCasters: [trackRender.mesh, ...rocks.pool.meshes],
        };
        worlds.push(world);
        setWorldCasters(world, []);
        return world;
    };

    const primary = buildWorld();
    return {
        track,
        primary,
        secondary(): RenderWorld {
            return worlds[1] ?? buildWorld();
        },
        worlds,
    };
}

/** Add one world to one mode scene: its lights, its track piece, and the shared boulders + ground. */
export function addWorldToScene(scene: SceneContext, world: RenderWorld): void {
    for (const light of world.lights) {
        addToScene(scene, light);
    }
    addTrackToScene(scene, world.track);
    addRocksToScene(scene, world.rocks);
    addTerrainToScene(scene, world.terrain);
}

/** Re-supply this world's cascades with its own casters plus `extra` (a race grid's ships).
 *  Pass an empty `extra` when a mode ends, so the cascades stop referencing its disposed ships. */
export function setWorldCasters(world: RenderWorld, extra: readonly Mesh[]): void {
    // A NEW array each time: the caster set is diffed by identity, so re-supplying is how a
    // mode publishes its ships to the cascades.
    setShadowTaskCasterMeshes(world.shadowGenerator, [...world.baseCasters, ...extra]);
}
