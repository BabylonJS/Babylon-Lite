import type { Vec3, Color4 } from "../../math/types.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Particle, ParticleScale } from "../particle.js";
import type { ParticleSystem } from "../particle-system.js";

/** Any value that can flow along a node-particle connection. */
export type ParticleValue = number | Vec3 | Color4 | ParticleScale | ParticleSystem | Texture2D | null | undefined;

/** Pulls an output's value for the current build/particle context (mirrors BJS `_storedFunction`). */
export type NpeGetter = (state: NpeBuildState) => ParticleValue;

/** A parsed connection on a block input. `targetBlockId === null` means the input is unconnected. */
export interface ParsedParticleInput {
    name: string;
    targetBlockId: number | null;
    targetConnectionName: string | null;
    /** Literal value serialized on the input itself (used when unconnected), if any. */
    value?: unknown;
    /** Type tag for {@link value} (e.g. `number`, `BABYLON.Vector3`, `BABYLON.Color4`). */
    valueType?: string;
}

/** A parsed graph block. The raw `serialized` object carries block-specific fields. */
export interface ParsedParticleBlock {
    id: number;
    /** Class name with the `BABYLON.` prefix stripped (e.g. `SystemBlock`). */
    className: string;
    name: string;
    inputs: ParsedParticleInput[];
    /** Raw serialized block, for block-specific fields (value, type, url, operation, lockMode, capacity, …). */
    serialized: Record<string, unknown>;
}

/** A parsed node-particle graph. */
export interface ParticleGraph {
    blocks: Map<number, ParsedParticleBlock>;
    /** Ids of the `SystemBlock` roots — one built {@link ParticleSystem} per root. */
    systemBlockIds: number[];
}

/**
 * Per-evaluation context — the analogue of Babylon.js `NodeParticleBuildState`. Serves both build
 * time (capacity, emitter) and run time (`particle`/`system` context for contextual-source pulls).
 */
export interface NpeBuildState {
    /** The system being built/animated (`systemContext`). Set when `CreateParticleBlock` builds it. */
    system: ParticleSystem | null;
    /** The particle currently being processed (`particleContext`). Set per-particle at runtime. */
    particle: Particle | null;
    /** Capacity for the system under construction (set by the SystemBlock before the build walk). */
    capacity: number;
    /** Emitter world position (pure-translation emitter). */
    emitter: Vec3;
    /** The hosting scene (for camera-dependent blocks such as AlignAngle). */
    scene: SceneContext;
    /** Base URL used to resolve relative texture URLs in the graph (mirrors BJS texture-base resolution). */
    textureBaseUrl?: string;
}

/** Build context handed to each block evaluator during the build walk. */
export interface NpeBuildContext {
    /** The current build state. */
    state: NpeBuildState;
    /** The engine (for asset loads). */
    engine: EngineContext;
    /** Resolve a block input to a value getter; returns `fallback` (or a null getter) when unconnected. */
    input(block: ParsedParticleBlock, name: string, fallback?: NpeGetter): NpeGetter;
    /** Whether a block input is connected to a source. */
    isConnected(block: ParsedParticleBlock, name: string): boolean;
    /** Register an output getter for a block. */
    setOutput(blockId: number, name: string, getter: NpeGetter): void;
    /** Register a deferred asset-load promise that must settle before the set is considered ready. */
    addBuildPromise(promise: Promise<void>): void;
}

/** A block evaluator: wires a parsed block into the runtime during the build walk. */
export interface ParticleBlockEvaluator {
    /** Build this block — resolve inputs, register output getters, and/or attach create/update closures. */
    build(block: ParsedParticleBlock, ctx: NpeBuildContext): void;
}
