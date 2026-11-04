/**
 * Racer lighting — a directional "sun" plus a hemispheric ambient fill, tuned to
 * the warm, cheerful key light of the Kenney kit's default environment.
 *
 * The sun direction mirrors the kit's `DirectionalLight3D` basis (light travels
 * along the node's -Z). The demo attaches a CSM directional shadow generator to
 * this sun (in racer.ts) so the car and props cast shadows onto the road.
 */

import type { LightBase } from "babylon-lite";
import { createDirectionalLight, createHemisphericLight } from "babylon-lite";

export interface RacerLighting {
    readonly lights: readonly LightBase[];
    /** The directional sun, for attaching a shadow generator. */
    readonly sun: ReturnType<typeof createDirectionalLight>;
}

export function buildLighting(): RacerLighting {
    // Sky/ground ambient fill — a touch of warm sky over cool ground bounce.
    const ambient = createHemisphericLight([0.3, 1, 0.2], 0.85);
    ambient.diffuseColor = [1.0, 0.98, 0.9];
    ambient.groundColor = [0.42, 0.45, 0.4];

    // Directional sun (direction copied from the kit's sun basis: travels along -Z).
    const sun = createDirectionalLight([-0.58, -0.77, 0.27], 1.5);
    sun.diffuse = [1.0, 0.96, 0.86];

    return { lights: [ambient, sun], sun };
}
