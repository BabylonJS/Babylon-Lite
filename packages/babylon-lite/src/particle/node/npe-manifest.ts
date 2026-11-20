import type { NpeBlockEvaluator } from "./npe-build.js";

/** Lazy loader of one block module. Every module listed in a manifest table exports its evaluator as `npeBlock`. */
export type NpeBlockLoader = () => Promise<{ npeBlock: NpeBlockEvaluator }>;

/** A null-prototype table from serialized Babylon.js class name to its block loader. */
export type NpeBlockTable = Readonly<Record<string, NpeBlockLoader | undefined>>;

/**
 * Node-particle block manifest — one lazy entry per supported Babylon.js block class, split by class into two tables.
 *
 * This base table lists exactly the classes Babylon.js's `ConvertToNodeParticleSystemSetAsync` emits for a default
 * `ParticleSystem`, which also covers the editor's default graph (`NodeParticleSystemSet.setToDefault`). Every other
 * class, including each newly supported one, belongs in `npe-manifest-extra.ts`, which only graphs that reach one of
 * its classes fetch. Membership follows that rule, never a per-class size measurement.
 *
 * Each block module owns every serialized property and input form of its class; heavy optional paths are
 * block-local lazy imports, so the builder never routes on block properties. Graph-plumbing classes (teleports,
 * elbows, debug) are removed by `normalizeNodeParticleGraph` and are intentionally absent from both tables.
 */
// Null prototype: serialized class names such as "constructor" must not resolve to inherited members.
const NPE_BLOCKS = {
    __proto__: null,
    SystemBlock: () => import("./blocks/system-block.js"),
    CreateParticleBlock: () => import("./blocks/create-particle-block.js"),
    BoxShapeBlock: () => import("./blocks/box-shape-block.js"),
    UpdatePositionBlock: () => import("./blocks/update-position-block.js"),
    UpdateColorBlock: () => import("./blocks/update-color-block.js"),
    ParticleTextureSourceBlock: () => import("./blocks/texture-source-block.js"),
    ParticleInputBlock: () => import("./blocks/particle-input-block.js"),
    ParticleMathBlock: () => import("./blocks/particle-math-block.js"),
    ParticleLerpBlock: () => import("./blocks/particle-lerp-block.js"),
    ParticleConverterBlock: () => import("./blocks/particle-converter-block.js"),
    ParticleRandomBlock: () => import("./blocks/particle-random-block.js"),
} as unknown as NpeBlockTable;

/** Load the evaluator of one serialized block class. Throws for classes Lite does not implement. */
export async function loadNpeBlock(className: string): Promise<NpeBlockEvaluator> {
    const load = NPE_BLOCKS[className] ?? (await import("./npe-manifest-extra.js")).NPE_EXTRA_BLOCKS[className];
    if (!load) {
        throw new Error(`NodeParticle: unsupported block "${className}"`);
    }
    return (await load()).npeBlock;
}
