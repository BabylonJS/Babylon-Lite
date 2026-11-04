import { animateParticleSystem, startParticleSystem } from "./particle-system.js";
import { createParticleBillboard, syncParticleBillboard } from "./particle-billboard.js";
import { addFacingBillboardSystem } from "../sprite/billboard-scene.js";
import type { SceneContext } from "../scene/scene.js";
import type { NodeParticleSet } from "./node/node-particle.js";
import type { ParticleSystem } from "./particle-system.js";

/** Systems registered through registerNodeParticleSet, in first-registration order, listed once.
 *  Returns a live readonly array; copy for a snapshot. Scene disposal clears the list. */
export function getParticleSystems(scene: SceneContext): readonly ParticleSystem[] {
    return scene._particleSystems ?? [];
}

/** One simulated frame at 60 fps, used to convert frame delta time to an update-speed ratio. */
const FRAME_MS = 1000 / 60;

/** Options for {@link registerNodeParticleSet}. */
export interface RegisterNodeParticleOptions {
    /** Start emission immediately (default `true`). */
    autoStart?: boolean;
}

/**
 * Register a built node particle set with the scene: each system is rendered as a camera-facing billboard
 * system and advanced once per frame (scaled by the real frame delta). Use this for live/interactive scenes.
 * Deterministic parity scenes drive the simulation manually instead (seed RNG → step N → sync → freeze).
 */
export function registerNodeParticleSet(scene: SceneContext, set: NodeParticleSet, options: RegisterNodeParticleOptions = {}): void {
    const autoStart = options.autoStart ?? true;

    for (const system of set.systems) {
        const billboard = createParticleBillboard(system);
        (system._registerBillboard ?? addFacingBillboardSystem)(scene, billboard);

        if (!scene._particleSystems) {
            const systems: ParticleSystem[] = (scene._particleSystems = []);
            scene._disposables.push(() => {
                systems.length = 0;
            });
        }
        if (!scene._particleSystems.includes(system)) {
            scene._particleSystems.push(system);
        }

        if (autoStart) {
            startParticleSystem(system);
        }

        scene._beforeRender.push((deltaMs) => {
            const ratio = deltaMs > 0 ? deltaMs / FRAME_MS : 1;
            animateParticleSystem(system, ratio);
            syncParticleBillboard(system, billboard);
        });
    }
}
