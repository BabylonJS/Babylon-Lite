/**
 * Babylon.js-compatible `ParticleSystem` over Babylon Lite's data-oriented
 * node-particle runtime.
 *
 * Babylon.js exposes `ParticleSystem` both as an **imperative constructor**
 * (`new ParticleSystem(name, capacity, scene)` — emitters, over-lifetime
 * gradients, `minEmitBox`) and as the **per-system handle** returned from a built
 * Node Particle Editor graph (`NodeParticleSystemSet.buildAsync(scene).systems[i]`).
 *
 * Babylon Lite backs only the second shape: `buildNodeParticleSet` compiles a
 * serialized graph into `NodeParticleSet.systems` (Lite `ParticleSystem` state
 * objects), which the standalone functions `startParticleSystem` /
 * `animateParticleSystem` / `stopParticleSystem` drive, and
 * `createParticleBillboard` / `syncParticleBillboard` /
 * `addFacingBillboardSystem` render as camera-facing billboards. So the compat
 * wrapper's **runtime subset** (`start` / `animate` / `stop` / `updateSpeed` /
 * `particleTexture` / `preWarmStepOffset`) forwards to those Lite functions,
 * while the imperative constructor throws — there is no Lite graph to author.
 *
 * The instances handed back from {@link ParticleSystemSet.systems} are built via
 * the `@internal` {@link ParticleSystem._fromLite} factory, which bypasses the
 * throwing constructor (mirroring `AnimationGroup._fromLite`).
 */

import { startParticleSystem, animateParticleSystem, stopParticleSystem, createParticleBillboard, syncParticleBillboard, addFacingBillboardSystem } from "babylon-lite";
import type { ParticleSystem as LiteParticleSystem, Texture2D } from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import type { Texture } from "../textures/textures.js";
import { unsupported } from "../error.js";

/**
 * Babylon.js `ParticleSystem` — the built output of one NPE graph system. Backed
 * by a Lite `ParticleSystem`; the deterministic prewarm-and-freeze pattern used by
 * ported parity scenes (seed RNG → `start()` → N × `animate()` → `updateSpeed = 0`)
 * maps directly onto Lite's `startParticleSystem` / `animateParticleSystem`, with a
 * camera-facing billboard built and synced once the scene starts.
 */
export class ParticleSystem {
    public name = "";

    /** @internal The backing Lite particle system (null on a bare, unbuilt instance). */
    public _lite: LiteParticleSystem | null = null;
    /** @internal The compat scene this system was built against. */
    public _scene: Scene | null = null;

    /**
     * Babylon.js `ParticleSystem.preWarmStepOffset` — the step ratio applied during
     * prewarm cycles. Accepted for parity; ported deterministic scenes drive the
     * prewarm explicitly via repeated {@link animate} calls, so this is recorded but
     * does not itself advance the simulation.
     */
    public preWarmStepOffset = 1;

    private _texture: Texture | null = null;
    private _started = false;
    private _billboardScheduled = false;

    /**
     * Babylon.js `new ParticleSystem(name, capacity, scene)`. The imperative
     * construction API (emitters, over-lifetime gradients, `minEmitBox`, a
     * GPU-compute path) is not backed: Babylon Lite builds particle systems only
     * from a serialized Node Particle Editor graph. Load a graph via
     * `NodeParticleSystemSet.Parse` / `ParseFromSnippetAsync` → `buildAsync` and read
     * its {@link ParticleSystemSet.systems} instead.
     */
    public constructor() {
        unsupported(
            "ParticleSystem",
            "Babylon Lite builds particle systems only from a serialized Node Particle Editor graph, not the imperative classic `ParticleSystem` construction API (emitters, over-lifetime gradients, `minEmitBox`). Use `NodeParticleSystemSet.Parse`/`ParseFromSnippetAsync` → `buildAsync` and drive `set.systems[i]`."
        );
    }

    /**
     * @internal Build a `ParticleSystem` backed by a Lite `ParticleSystem` produced
     * by an NPE graph build. Bypasses the throwing public constructor.
     */
    public static _fromLite(lite: LiteParticleSystem, scene: Scene): ParticleSystem {
        const system = Object.create(ParticleSystem.prototype) as ParticleSystem;
        system.name = "";
        system._lite = lite;
        system._scene = scene;
        system.preWarmStepOffset = 1;
        system._texture = null;
        system._started = false;
        system._billboardScheduled = false;
        return system;
    }

    public getClassName(): string {
        return "ParticleSystem";
    }

    /** Babylon.js `ParticleSystem.updateSpeed` — simulation advance per frame. Proxies the Lite system. */
    public get updateSpeed(): number {
        return this._lite?.updateSpeed ?? 0;
    }
    public set updateSpeed(value: number) {
        if (this._lite) {
            this._lite.updateSpeed = value;
        }
    }

    /**
     * Babylon.js `ParticleSystem.particleTexture` — the sprite texture. Recorded and
     * bound onto the Lite system when the billboard is built at engine start (the
     * compat `Texture` loads asynchronously, so its GPU handle is read after the
     * scene's pending texture loads settle).
     */
    public get particleTexture(): Texture | null {
        return this._texture;
    }
    public set particleTexture(value: Texture | null) {
        this._texture = value;
    }

    /**
     * Babylon.js `ParticleSystem.start()` — begin emission. Forwards to Lite
     * `startParticleSystem` and schedules the camera-facing billboard build for
     * engine start (once the particle texture has loaded and the deterministic
     * prewarm has run). Idempotent.
     */
    public start(): void {
        if (!this._lite || this._started) {
            return;
        }
        this._started = true;
        startParticleSystem(this._lite);
        this._scheduleBillboard();
    }

    /**
     * Babylon.js `ParticleSystem.animate(preWarmOnly?)` — advance the simulation by
     * one deterministic step. Forwards to Lite `animateParticleSystem` with the
     * animation ratio of `1` used by the parity ports' seeded prewarm loop.
     */
    public animate(_preWarmOnly?: boolean): void {
        void _preWarmOnly;
        if (this._lite) {
            animateParticleSystem(this._lite, 1);
        }
    }

    /** Babylon.js `ParticleSystem.stop()` — stop emission; live particles drain. Forwards to Lite `stopParticleSystem`. */
    public stop(): void {
        if (this._lite) {
            stopParticleSystem(this._lite);
        }
    }

    /** Babylon.js `ParticleSystem.dispose()` — stop the system. */
    public dispose(): void {
        this.stop();
    }

    /**
     * Schedule the one-time billboard build. Deferred to engine start (via the
     * scene's `_deferAdd`, which runs after pending texture loads settle), so the
     * particle system is already prewarmed/frozen and its texture GPU handle is
     * ready. Mirrors the native Lite port's build → sync → add sequence.
     */
    private _scheduleBillboard(): void {
        if (this._billboardScheduled || !this._scene || !this._lite) {
            return;
        }
        this._billboardScheduled = true;
        const scene = this._scene;
        const lite = this._lite;
        scene._deferAdd(() => {
            const liteTexture = this._texture?._lite as Texture2D | undefined;
            if (liteTexture) {
                lite.texture = liteTexture;
            }
            if (!lite.texture) {
                return;
            }
            const billboard = createParticleBillboard(lite);
            syncParticleBillboard(lite, billboard);
            addFacingBillboardSystem(scene._lite, billboard);
        });
    }
}
