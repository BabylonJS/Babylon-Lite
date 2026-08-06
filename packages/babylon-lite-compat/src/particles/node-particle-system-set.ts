/**
 * Babylon.js-compatible Node Particle Editor (NPE) surface over Babylon Lite's
 * node-particle runtime.
 *
 * Babylon.js authors particle graphs as a `NodeParticleSystemSet` (a block graph),
 * then `buildAsync(scene)` compiles them into a live `ParticleSystemSet`. Babylon
 * Lite exposes the same capability through a fused parse+build entry point,
 * `parseNodeParticleSetFromSnippet(engine, scene, id, { json })`, plus
 * `registerNodeParticleSet(scene, set)` which wires each built system to a
 * camera-facing billboard system and advances it every frame.
 *
 * The compat wrapper bridges the two shapes: `Parse` / `ParseFromSnippetAsync` /
 * `ParseFromFileAsync` record the graph source and defer the single Lite call to
 * `buildAsync`, which returns a {@link ParticleSystemSet} wrapping the built Lite
 * `NodeParticleSet`. `ParticleSystemSet.start()` forwards to
 * `registerNodeParticleSet` (Lite owns all simulation + rendering); `dispose()`
 * stops emission via `stopParticleSystem`.
 *
 * The graph-authoring surface (programmatic blocks, `serialize`, `editAsync`,
 * `getBlockByName`) is **not** backed: Lite consumes a serialized graph and
 * exposes no block-construction API. The per-system runtime handles
 * (`ParticleSystemSet.systems[i]`) are backed — see {@link ParticleSystem}.
 */

import { parseNodeParticleSetFromSnippet, registerNodeParticleSet, stopParticleSystem } from "babylon-lite";
import type { NodeParticleSet as LiteNodeParticleSet } from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import { ParticleSystem } from "./particle-system.js";
import { unsupported } from "../error.js";

/**
 * Babylon.js `ParticleSystemSet` — the built output of an NPE graph. Backed by a
 * Lite `NodeParticleSet`; `start()` registers it as a live billboard system in the
 * scene. Directly constructing an empty set (`new ParticleSystemSet()`) is allowed
 * for parity but has no systems until produced by {@link NodeParticleSystemSet.buildAsync}.
 */
export class ParticleSystemSet {
    /** @internal The built Lite node-particle set (null for a directly-constructed empty set). */
    public _lite: LiteNodeParticleSet | null = null;
    /** @internal The compat scene the set was built against (set by `buildAsync`). */
    public _scene: Scene | null = null;

    private _started = false;
    /** @internal Cached per-system wrappers (stable identity across `systems` reads). */
    private _systems: ParticleSystem[] | null = null;

    public getClassName(): string {
        return "ParticleSystemSet";
    }

    /**
     * Babylon.js `ParticleSystemSet.systems` — the per-system {@link ParticleSystem}
     * handles. Each wraps one Lite `NodeParticleSet.systems[i]`, exposing the
     * runtime subset Lite backs (`start` / `animate` / `stop` / `updateSpeed` /
     * `particleTexture`). An empty (directly-constructed) set has no systems.
     */
    public get systems(): ParticleSystem[] {
        if (!this._lite || !this._scene) {
            return [];
        }
        if (!this._systems) {
            const scene = this._scene;
            this._systems = this._lite.systems.map((s) => {
                const system = ParticleSystem._fromLite(s, scene);
                // Wrappers materialized after set-level registration must not build a
                // second billboard for a system Lite already renders.
                if (this._started) {
                    system._releaseBillboardToSet();
                }
                return system;
            });
        }
        return this._systems;
    }

    /**
     * Babylon.js `ParticleSystemSet.start()` — begin all systems. Forwards to Lite
     * `registerNodeParticleSet`, which renders each system as a camera-facing
     * billboard and advances it once per frame. Idempotent.
     *
     * Per-system wrapper state (`systems[i].particleTexture`) is pushed onto the
     * backing Lite systems first, so the standard
     * `set.systems[i].particleTexture = texture; set.start()` sequence renders with
     * the assigned texture rather than the graph's. Registration is deferred to
     * engine start (`scene._deferAdd`, which runs after the scene's pending texture
     * loads settle) because a compat `Texture` resolves its GPU handle
     * asynchronously and Lite's billboard build needs it.
     */
    public start(): void {
        if (this._started || !this._lite || !this._scene) {
            return;
        }
        this._started = true;
        const scene = this._scene;
        const lite = this._lite;
        // Claim billboard rendering synchronously so an already-scheduled per-system
        // build (from `systems[i].start()`) is skipped when the deferred adds flush.
        for (const system of this._systems ?? []) {
            system._releaseBillboardToSet();
        }
        scene._deferAdd(() => {
            for (const system of this._systems ?? []) {
                system._bindTexture();
            }
            registerNodeParticleSet(scene._lite, lite, { autoStart: true });
        });
    }

    /**
     * Babylon.js `ParticleSystemSet.dispose()` — stop the systems. Lite exposes no
     * unregister for an already-registered billboard system, so this stops emission
     * on every built system (via `stopParticleSystem`); the last-emitted particles
     * finish their lifetime.
     */
    public dispose(): void {
        if (!this._lite) {
            return;
        }
        for (const system of this._lite.systems) {
            stopParticleSystem(system);
        }
    }
}

/**
 * Babylon.js `NodeParticleSystemSet` — a Node Particle Editor graph. The compat
 * wrapper supports the load→build→start path used by ported scenes; the
 * programmatic graph-authoring surface throws.
 */
export class NodeParticleSystemSet {
    public name: string;

    /** @internal Inline serialized graph (from `Parse` / `ParseFromFileAsync`); null when built from a snippet id. */
    public _source: object | string | null = null;
    /** @internal Snippet id (from `ParseFromSnippetAsync`); null when built from inline JSON. */
    public _snippetId: string | null = null;

    public constructor(name = "") {
        this.name = name;
    }

    public getClassName(): string {
        return "NodeParticleSystemSet";
    }

    /**
     * Babylon.js `NodeParticleSystemSet.buildAsync(scene)` — compile the graph into
     * a live {@link ParticleSystemSet}. Forwards to Lite
     * `parseNodeParticleSetFromSnippet`, which parses and builds in one shot (from
     * the recorded snippet id or inline JSON).
     */
    public async buildAsync(scene: Scene, _verbose = false): Promise<ParticleSystemSet> {
        void _verbose;
        const engine = scene.getEngine()._lite;
        const liteSet =
            this._snippetId !== null
                ? await parseNodeParticleSetFromSnippet(engine, scene._lite, this._snippetId, {})
                : await parseNodeParticleSetFromSnippet(engine, scene._lite, "", { json: this._source ?? {} });
        const set = new ParticleSystemSet();
        set._lite = liteSet;
        set._scene = scene;
        return set;
    }

    /** Babylon.js `NodeParticleSystemSet.Parse(source)` — deserialize an inline graph. */
    public static Parse(source: unknown): NodeParticleSystemSet {
        const name = (source as { name?: string } | null)?.name ?? "";
        const set = new NodeParticleSystemSet(name);
        set._source = source as object | string;
        return set;
    }

    /**
     * Babylon.js `NodeParticleSystemSet.ParseFromSnippetAsync(snippetId)` — load a
     * graph from the snippet server. The network fetch is deferred to `buildAsync`
     * (Lite fuses fetch+parse+build), so this resolves immediately with the id.
     */
    public static ParseFromSnippetAsync(snippetId: string, nodeParticleSet?: NodeParticleSystemSet): Promise<NodeParticleSystemSet> {
        const set = nodeParticleSet ?? new NodeParticleSystemSet();
        set._snippetId = snippetId;
        set.name = snippetId;
        return Promise.resolve(set);
    }

    /**
     * Babylon.js `NodeParticleSystemSet.ParseFromFileAsync(name, url)` — load a
     * serialized graph from a URL, then behave like {@link Parse}.
     */
    public static async ParseFromFileAsync(name: string, url: string, nodeParticleSet?: NodeParticleSystemSet): Promise<NodeParticleSystemSet> {
        const response = await fetch(url);
        const source = (await response.json()) as object;
        const set = nodeParticleSet ?? new NodeParticleSystemSet(name);
        set.name = name;
        set._source = source;
        return set;
    }

    /** Babylon.js `NodeParticleSystemSet.CreateDefault(name)`. Requires programmatic block authoring — not backed. */
    public static CreateDefault(_name: string): NodeParticleSystemSet {
        void _name;
        return unsupported(
            "NodeParticleSystemSet.CreateDefault",
            "Babylon Lite consumes a serialized node-particle graph (snippet id or JSON); it has no programmatic block-authoring API to assemble a default graph. Load a graph via `Parse` / `ParseFromSnippetAsync` instead."
        );
    }

    public get attachedBlocks(): never {
        return unsupported(
            "NodeParticleSystemSet.attachedBlocks",
            "Babylon Lite consumes a serialized node-particle graph and exposes no programmatic block graph. Load and build a graph via `Parse` / `ParseFromSnippetAsync` + `buildAsync`."
        );
    }

    public getBlockByName(_name: string): never {
        void _name;
        return unsupported("NodeParticleSystemSet.getBlockByName", "Babylon Lite exposes no programmatic node-particle block graph to query.");
    }

    public serialize(): never {
        return unsupported("NodeParticleSystemSet.serialize", "Babylon Lite exposes no programmatic node-particle block graph to serialize.");
    }

    public editAsync(): never {
        return unsupported("NodeParticleSystemSet.editAsync", "The Node Particle Editor UI is not part of the Babylon Lite compat layer.");
    }

    public dispose(): void {
        this._source = null;
        this._snippetId = null;
    }
}
