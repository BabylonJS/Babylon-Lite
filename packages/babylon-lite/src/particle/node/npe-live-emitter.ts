import { allocateMat4 } from "../../math/_matrix-allocator.js";
import { mat4InvertToRefOrIdentity } from "../../math/mat4-invert.js";
import { mat4GetTranslationToRef } from "../../math/mat4-transform.js";
import type { Mat4, Mat4Storage } from "../../math/types.js";
import type { NodeParticleSet } from "./npe-build.js";

const INVALID_PROVIDER_RESULT = "NodeParticle: emitter provider must return a finite 16-element matrix";
const EMPTY_SET = "NodeParticle: emitter provider requires a non-empty built set";
const INCONSISTENT_SET = "NodeParticle: emitter provider requires consistently enabled systems";

function copyMatrix(source: Mat4, target: Mat4): void {
    const output = target as unknown as Mat4Storage;
    for (let index = 0; index < 16; index++) {
        output[index] = source[index]!;
    }
}

function sampleProvider(provider: () => Mat4, target: Mat4): void {
    const provided = provider() as Mat4 | null | undefined;
    if (!provided || provided.length !== 16) {
        throw new Error(INVALID_PROVIDER_RESULT);
    }
    const output = target as unknown as Mat4Storage;
    for (let index = 0; index < 16; index++) {
        const value = provided[index];
        if (!Number.isFinite(value)) {
            throw new Error(INVALID_PROVIDER_RESULT);
        }
        output[index] = value!;
    }
}

/** @internal Dynamically loaded implementation for the public emitter-provider enabler. */
export function enableNodeParticleEmitterProviderRuntime(set: NodeParticleSet, provider: () => Mat4): NodeParticleSet {
    if (set.systems.length === 0) {
        throw new Error(EMPTY_SET);
    }

    const installed = set.systems[0]?._emitterProvider;
    if (!set.systems.every((system) => system._emitterProvider === installed)) {
        throw new Error(INCONSISTENT_SET);
    }

    if (installed) {
        const previousProvider = installed.provider;
        installed.provider = provider;
        try {
            installed.refresh();
        } catch (error) {
            installed.provider = previousProvider;
            throw error;
        }
        return set;
    }

    const states = set.systems.map((system) => {
        if (!system._emitter) {
            throw new Error("NodeParticle: emitter provider requires a set produced by a node-particle builder");
        }
        return system._emitter;
    });
    const nextMatrix = allocateMat4();
    const inverseScratch = states.some((state) => (state.emitterInverseWorldMatrices?.length ?? 0) > 0) ? allocateMat4() : undefined;
    const providerState = {
        provider,
        refresh: (): void => {
            sampleProvider(providerState.provider, nextMatrix);
            if (inverseScratch) {
                mat4InvertToRefOrIdentity(nextMatrix, inverseScratch);
            }

            for (let stateIndex = 0; stateIndex < states.length; stateIndex++) {
                const state = states[stateIndex]!;
                copyMatrix(nextMatrix, state.emitterWorldMatrix);
                mat4GetTranslationToRef(nextMatrix, state.emitter);
                const inverses = state.emitterInverseWorldMatrices;
                if (inverses && inverseScratch) {
                    for (let inverseIndex = 0; inverseIndex < inverses.length; inverseIndex++) {
                        copyMatrix(inverseScratch, inverses[inverseIndex]!.inverse);
                    }
                }
            }
        },
    };

    providerState.refresh();
    for (const system of set.systems) {
        const prepareFrame = system._prepareFrame;
        system._prepareFrame = () => {
            providerState.refresh();
            prepareFrame?.();
        };
        system._emitterProvider = providerState;
    }
    return set;
}
