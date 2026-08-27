/**
 * Antigravity Racer — procedural decorative rocks.
 *
 * The source PG loads an external Sketchfab rock glTF; this port scatters
 * simple procedural low-poly "boulders" (irregularly-scaled polyhedra) outside
 * the track walls instead, avoiding any runtime dependency on third-party
 * asset hosting (see GUIDANCE: avoid mutable remote dependencies).
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import { addToScene, createPolyhedron, createStandardMaterial } from "babylon-lite";

import type { TrackData } from "./track.js";
import { RING_COUNT } from "./constants.js";

/** Small deterministic PRNG (mulberry32) so the rock scatter is stable across rebuilds. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ROCK_COUNT = 9;
const ROCK_SEED = 20240521;

export function createRocks(engine: EngineContext, track: TrackData): Mesh[] {
    const rng = mulberry32(ROCK_SEED);
    const material = createStandardMaterial();
    material.diffuseColor = [0.32, 0.29, 0.27];
    material.specularColor = [0.05, 0.05, 0.05];

    const rocks: Mesh[] = [];
    for (let i = 0; i < ROCK_COUNT; i++) {
        const ring = Math.floor(rng() * RING_COUNT);
        const frame = track.frames[ring]!;
        const side = rng() > 0.5 ? 1 : -1;
        const outset = 6 + rng() * 6;
        const drop = -1 - rng() * 4;
        const x = frame.pos.x + frame.right.x * side * outset + frame.up.x * drop;
        const y = frame.pos.y + frame.right.y * side * outset + frame.up.y * drop;
        const z = frame.pos.z + frame.right.z * side * outset + frame.up.z * drop;

        const rock = createPolyhedron(engine, { type: Math.floor(rng() * 4), size: 1.6 + rng() * 2.2 });
        rock.material = material;
        rock.position.set(x, y, z);
        rock.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
        rock.scaling.set(0.7 + rng() * 0.6, 0.55 + rng() * 0.7, 0.7 + rng() * 0.6);
        rocks.push(rock);
    }
    return rocks;
}

export function addRocksToScene(scene: SceneContext, rocks: readonly Mesh[]): void {
    for (const rock of rocks) {
        addToScene(scene, rock);
    }
}
