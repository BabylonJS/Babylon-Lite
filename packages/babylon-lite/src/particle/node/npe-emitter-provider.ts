import { allocateMat4 } from "../../math/_matrix-allocator.js";
import { mat4InvertToRefOrIdentity } from "../../math/mat4-invert-to-ref.js";
import { mat4GetTranslationToRef } from "../../math/mat4-transform.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mat4, Mat4Storage } from "../../math/types.js";
import type { ParticleEmitterInverse } from "../particle-system.js";
import type { SceneContext } from "../../scene/scene.js";
import { buildNodeParticleSet } from "./npe-build.js";
import type { BuildNodeParticleOptions, NodeParticleSet, NpeBuildState } from "./npe-build.js";
import type { ParticleGraph } from "./npe-types.js";

/** Pure-state source sampled for the emitter world transform. */
export type NodeParticleEmitterProvider = () => Mat4;

function copyMatrix(source: ArrayLike<number>, target: Mat4): void {
    const output = target as unknown as Mat4Storage;
    for (let index = 0; index < 16; index++) {
        output[index] = source[index]!;
    }
}

function sampleProvider(provider: NodeParticleEmitterProvider): Mat4 {
    const provided = provider() as Mat4 | null | undefined;
    if (!provided || provided.length !== 16) {
        throw new Error("NodeParticle: emitter provider must return a finite 16-element matrix");
    }
    for (let index = 0; index < 16; index++) {
        const value = provided[index];
        if (!Number.isFinite(value)) {
            throw new Error("NodeParticle: emitter provider must return a finite 16-element matrix");
        }
    }
    return provided;
}

/**
 * Return a provider-backed copy of options while preserving builder-specific option fields.
 * Samples and validates the provider once before returning. The provider takes precedence over any `emitter` or `emitterWorldMatrix` in `options`; provider errors and invalid matrices throw synchronously.
 */
export function withNodeParticleEmitterProvider<T extends object = BuildNodeParticleOptions>(
    provider: NodeParticleEmitterProvider,
    options?: T & BuildNodeParticleOptions
): T & BuildNodeParticleOptions {
    const initialMatrix = Array.from(sampleProvider(provider));
    return {
        ...options,
        _setupEmitter: (state: NpeBuildState): void => {
            const system = state.system!;
            const emitter = state.emitter;
            const emitterWorldMatrix = allocateMat4();
            const emitterInverseWorldMatrices: ParticleEmitterInverse[] = [];
            state.emitterWorldMatrix = emitterWorldMatrix;
            state.emitterInverseWorldMatrices = emitterInverseWorldMatrices;
            copyMatrix(initialMatrix, emitterWorldMatrix);
            mat4GetTranslationToRef(emitterWorldMatrix, emitter);

            const nextMatrix = allocateMat4();
            let inverseScratch: Mat4 | undefined;
            const prepareFrame = system._prepareFrame;
            system._prepareFrame = () => {
                copyMatrix(sampleProvider(provider), nextMatrix);
                if (emitterInverseWorldMatrices.length) {
                    inverseScratch ??= allocateMat4();
                    mat4InvertToRefOrIdentity(nextMatrix, inverseScratch);
                }
                copyMatrix(nextMatrix, emitterWorldMatrix);
                mat4GetTranslationToRef(nextMatrix, emitter);
                if (inverseScratch) {
                    for (const inverse of emitterInverseWorldMatrices) {
                        copyMatrix(inverseScratch, inverse.inverse);
                    }
                }
                prepareFrame?.();
            };
        },
    } as T & BuildNodeParticleOptions;
}

/** Build an NPE set with a live emitter provider. */
export async function buildNodeParticleSetWithEmitterProvider(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    provider: NodeParticleEmitterProvider,
    options: BuildNodeParticleOptions = {}
): Promise<NodeParticleSet> {
    return buildNodeParticleSet(engine, scene, graph, withNodeParticleEmitterProvider(provider, options));
}
