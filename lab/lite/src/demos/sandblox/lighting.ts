/**
 * Lighting — configures scene lights and the shadow generator for Sandblox.
 *
 * Creates a hemispheric ambient light and a directional "sun" light with
 * PCF shadow mapping. Returns all entities ready to be added to the scene.
 */

import type { DirectionalLight, EngineContext, LightBase, Mesh, ShadowGenerator } from "babylon-lite";
import { createDirectionalLight, createHemisphericLight, createPcfDirectionalShadowGenerator, setShadowTaskCasterMeshes } from "babylon-lite";

export interface LightingResult {
    /** All lights to add to the scene. */
    readonly lights: readonly LightBase[];
    /** The directional (sun) light — carries the shadow generator. */
    readonly sun: DirectionalLight;
    /** The shadow generator attached to the sun. */
    readonly shadowGenerator: ShadowGenerator;
}

/**
 * Build the demo's lighting rig: hemispheric ambient + directional sun with
 * PCF shadows. Call {@link setShadowCasters} after character meshes are built.
 */
export function buildLighting(engine: EngineContext): LightingResult {
    // Ambient fill — reduced intensity so directional shadows have contrast
    const ambient = createHemisphericLight([0, 1, 0], 0.8);
    ambient.diffuseColor = [1.0, 0.9, 0.75];
    ambient.groundColor = [0.3, 0.35, 0.45];

    // Directional sun.
    const sun = createDirectionalLight([0.25, -1, 0.9], 0.5);
    sun.diffuse = [1.0, 0.97, 0.88];
    sun.position.set(30, 50, 20);

    // PCF shadow generator for crisp directional shadows
    // The starter map can grow the caster AABB, which
    // dropped per-stud depth precision and surfaced diagonal acne stripes on
    // faces at grazing light angles. Bias is the only implemented lever —
    // the engine's `normalBias` option is declared but never consumed
    // (engine gap, see STATUS.md). 2048 map + tighter far plane + ~10x bias
    // kills the stripes without visible peter-panning at brick scale.
    sun.shadowGenerator = createPcfDirectionalShadowGenerator(engine, sun, {
        mapSize: 2048,
        bias: 0.0012,
        darkness: 0.01,
        orthoMinZ: 0.1,
        orthoMaxZ: 150,
        forceRefreshEveryFrame: true,
    });

    return {
        lights: [ambient, sun],
        sun,
        shadowGenerator: sun.shadowGenerator,
    };
}

/**
 * Register meshes as shadow casters. Call after the character is built.
 */
export function setShadowCasters(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): void {
    setShadowTaskCasterMeshes(shadowGenerator, casterMeshes);
}
