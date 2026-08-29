import type { NpeBlockEvaluator } from "./npe-build.js";

/** A parsed connection on a block input. `targetBlockId === null` means the input is unconnected. */
export interface ParsedParticleInput {
    readonly name: string;
    readonly targetBlockId: number | null;
    readonly targetConnectionName: string | null;
    /** Literal value serialized on the input itself (used when unconnected), if any. */
    readonly value?: unknown;
    /** Type tag for {@link value} (e.g. `number`, `BABYLON.Vector3`, `BABYLON.Color4`). */
    readonly valueType?: string;
}

/** A parsed graph block. The raw `serialized` object carries block-specific fields. */
export interface ParsedParticleBlock {
    readonly id: number;
    /** Class name with the `BABYLON.` prefix stripped (e.g. `SystemBlock`). */
    readonly className: string;
    readonly name: string;
    readonly inputs: readonly ParsedParticleInput[];
    /** Raw serialized block, for block-specific fields (value, type, url, operation, lockMode, capacity, …). */
    readonly serialized: Readonly<Record<string, unknown>>;
}

/** A parsed node-particle graph. */
export interface ParticleGraph {
    readonly blocks: ReadonlyMap<number, ParsedParticleBlock>;
    /** Ids of the `SystemBlock` roots — one runtime system is built per root. */
    readonly systemBlockIds: readonly number[];
    /** @internal Optional evaluator resolver installed by builder feature preflight. */
    _loadEvaluator?: (block: ParsedParticleBlock) => Promise<NpeBlockEvaluator>;
    /** @internal True only on a graph returned by the graph-plumbing normalizer. */
    readonly _isGraphPlumbingNormalized?: true;
}
