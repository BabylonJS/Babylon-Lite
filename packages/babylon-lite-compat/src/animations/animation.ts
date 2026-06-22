/**
 * Babylon.js-compatible `Animation` keyframe model + `AnimationGroup`.
 *
 * `Animation` is a pure-JS keyframe container with CPU evaluation (`evaluate`),
 * the Babylon.js data-type / loop-mode constants, and `setKeys`/`getKeys`. This
 * is fully testable without a GPU. `AnimationGroup` provides the structural
 * grouping/playback-state surface; frame-accurate playback is driven through the
 * native Babylon Lite animation manager when wired to a scene (not modelled here).
 */

import { goToFrame as liteGoToFrame, playAnimation, pauseAnimation, stopAnimation, setAnimationAdditive } from "babylon-lite";
import type { AnimationGroup as LiteAnimationGroup, EngineContext } from "babylon-lite";

export interface IAnimationKey {
    frame: number;
    value: number | number[];
    /** Babylon.js per-key interpolation hint (`AnimationKeyInterpolation`). */
    interpolation?: number;
}

/**
 * Babylon.js `AnimationKeyInterpolation` — how the segment starting at a key is
 * interpolated. `STEP` holds the key's value until the next key (no blend).
 */
export const AnimationKeyInterpolation = {
    NONE: 0,
    STEP: 1,
} as const;

export const AnimationTypes = {
    ANIMATIONTYPE_FLOAT: 0,
    ANIMATIONTYPE_VECTOR3: 1,
    ANIMATIONTYPE_QUATERNION: 2,
    ANIMATIONTYPE_MATRIX: 3,
    ANIMATIONTYPE_COLOR3: 4,
    ANIMATIONTYPE_VECTOR2: 5,
    ANIMATIONTYPE_COLOR4: 6,
} as const;

export const AnimationLoopModes = {
    ANIMATIONLOOPMODE_RELATIVE: 0,
    ANIMATIONLOOPMODE_CYCLE: 1,
    ANIMATIONLOOPMODE_CONSTANT: 2,
} as const;

export class Animation {
    public static readonly ANIMATIONTYPE_FLOAT = AnimationTypes.ANIMATIONTYPE_FLOAT;
    public static readonly ANIMATIONTYPE_VECTOR3 = AnimationTypes.ANIMATIONTYPE_VECTOR3;
    public static readonly ANIMATIONTYPE_QUATERNION = AnimationTypes.ANIMATIONTYPE_QUATERNION;
    public static readonly ANIMATIONTYPE_MATRIX = AnimationTypes.ANIMATIONTYPE_MATRIX;
    public static readonly ANIMATIONTYPE_COLOR3 = AnimationTypes.ANIMATIONTYPE_COLOR3;
    public static readonly ANIMATIONLOOPMODE_RELATIVE = AnimationLoopModes.ANIMATIONLOOPMODE_RELATIVE;
    public static readonly ANIMATIONLOOPMODE_CYCLE = AnimationLoopModes.ANIMATIONLOOPMODE_CYCLE;
    public static readonly ANIMATIONLOOPMODE_CONSTANT = AnimationLoopModes.ANIMATIONLOOPMODE_CONSTANT;

    private _keys: IAnimationKey[] = [];

    public constructor(
        public name: string,
        public targetProperty: string,
        public framePerSecond: number,
        public dataType: number = AnimationTypes.ANIMATIONTYPE_FLOAT,
        public loopMode: number = AnimationLoopModes.ANIMATIONLOOPMODE_CYCLE
    ) {}

    public setKeys(keys: IAnimationKey[]): void {
        this._keys = keys.slice().sort((a, b) => a.frame - b.frame);
    }

    public getKeys(): IAnimationKey[] {
        return this._keys;
    }

    public getHighestFrame(): number {
        return this._keys.length > 0 ? this._keys[this._keys.length - 1]!.frame : 0;
    }

    /** Linearly evaluate the animated value at `frame` (clamped to the key range). */
    public evaluate(frame: number): number | number[] {
        const keys = this._keys;
        if (keys.length === 0) {
            return 0;
        }
        if (frame <= keys[0]!.frame) {
            return keys[0]!.value;
        }
        if (frame >= keys[keys.length - 1]!.frame) {
            return keys[keys.length - 1]!.value;
        }
        for (let i = 0; i < keys.length - 1; i++) {
            const a = keys[i]!;
            const b = keys[i + 1]!;
            // Half-open `[a, b)` so an exact key frame belongs to the segment it
            // starts (matters for STEP, where the value changes _at_ the next key).
            if (frame >= a.frame && frame < b.frame) {
                // Babylon.js `AnimationKeyInterpolation.STEP` holds the start key's
                // value across the whole segment (no blend to the next key).
                if (a.interpolation === AnimationKeyInterpolation.STEP) {
                    return a.value;
                }
                const t = (frame - a.frame) / (b.frame - a.frame);
                return lerpValue(a.value, b.value, t);
            }
        }
        return keys[keys.length - 1]!.value;
    }

    /** Babylon.js helper: build a one-shot float animation between two values. */
    public static CreateAndStartAnimation(name: string, _target: unknown, targetProperty: string, framePerSecond: number, totalFrame: number, from: number, to: number): Animation {
        const anim = new Animation(name, targetProperty, framePerSecond);
        anim.setKeys([
            { frame: 0, value: from },
            { frame: totalFrame, value: to },
        ]);
        return anim;
    }
}

function lerpValue(a: number | number[], b: number | number[], t: number): number | number[] {
    if (typeof a === "number" && typeof b === "number") {
        return a + (b - a) * t;
    }
    const av = a as number[];
    const bv = b as number[];
    return av.map((value, i) => value + ((bv[i] ?? value) - value) * t);
}

type AnimValue = number | number[];

function scaleValue(value: AnimValue, scale: number): AnimValue {
    return typeof value === "number" ? value * scale : value.map((v) => v * scale);
}

function addValue(acc: AnimValue, value: AnimValue): AnimValue {
    if (typeof acc === "number" && typeof value === "number") {
        return acc + value;
    }
    const a = acc as number[];
    const v = value as number[];
    return a.map((x, i) => x + (v[i] ?? 0));
}

function zeroLike(value: AnimValue): AnimValue {
    return typeof value === "number" ? 0 : (value as number[]).map(() => 0);
}

/**
 * @internal Pre-animation baseline of each blended property, captured the first
 * time a structural group starts. Babylon.js mixes this "original value" back in
 * when a property's total animation weight is below 1 (so partially-weighted
 * blends settle toward the rest pose); keyed by target object → dotted path.
 */
const structuralOriginals = new WeakMap<object, Map<string, AnimValue>>();

function readPath(target: object, path: string): AnimValue {
    const parts = path.split(".");
    let obj = target as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = obj[parts[i]!];
        if (next == null) {
            return 0;
        }
        obj = next as Record<string, unknown>;
    }
    const leaf = obj[parts[parts.length - 1]!];
    return typeof leaf === "number" ? leaf : 0;
}

function captureOriginal(target: object, path: string): void {
    let perTarget = structuralOriginals.get(target);
    if (!perTarget) {
        perTarget = new Map();
        structuralOriginals.set(target, perTarget);
    }
    if (!perTarget.has(path)) {
        perTarget.set(path, readPath(target, path));
    }
}

/** @internal Assign an animated value to `target` following a dotted property path (e.g. `"position.x"`). */
function applyAnimatedValue(target: unknown, path: string, value: number | number[]): void {
    const parts = path.split(".");
    let obj = target as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = obj[parts[i]!];
        if (next == null) {
            return;
        }
        obj = next as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (Array.isArray(value)) {
        const slot = obj[leaf] as { set?: (...n: number[]) => void } | undefined;
        if (slot && typeof slot.set === "function") {
            slot.set(...value);
        } else {
            obj[leaf] = value;
        }
    } else {
        obj[leaf] = value;
    }
}

/**
 * Babylon.js `Animatable` — a running animation on a target, driven per-frame on
 * the CPU by evaluating each `Animation`'s keyframes and writing the result onto
 * the target's (dotted) property path.
 */
export class Animatable {
    public masterFrame = 0;
    public speedRatio: number;
    private _paused = false;
    private _stopped = false;

    public constructor(
        private readonly _target: unknown,
        private readonly _animations: Animation[],
        private readonly _from: number,
        private readonly _to: number,
        private readonly _loop: boolean,
        speedRatio: number
    ) {
        this.speedRatio = speedRatio;
        this.masterFrame = _from;
        this._apply();
    }

    /** @internal Advance the animation by `deltaMs`, called once per scene frame. */
    public _tick(deltaMs: number): void {
        if (this._paused || this._stopped) {
            return;
        }
        const fps = this._animations[0]?.framePerSecond ?? 60;
        this.masterFrame += (deltaMs / 1000) * fps * this.speedRatio;
        if (this.masterFrame > this._to) {
            if (this._loop) {
                const span = this._to - this._from || 1;
                this.masterFrame = this._from + ((this.masterFrame - this._from) % span);
            } else {
                this.masterFrame = this._to;
                this._stopped = true;
            }
        }
        this._apply();
    }

    public goToFrame(frame: number): void {
        this.masterFrame = frame;
        this._apply();
    }

    public pause(): void {
        this._paused = true;
    }

    public restart(): void {
        this._paused = false;
        this._stopped = false;
        this.masterFrame = this._from;
    }

    public stop(): void {
        this._stopped = true;
    }

    public get animationStarted(): boolean {
        return !this._stopped;
    }

    private _apply(): void {
        for (const anim of this._animations) {
            applyAnimatedValue(this._target, anim.targetProperty, anim.evaluate(this.masterFrame));
        }
    }
}

export type AnimationGroupState = "init" | "playing" | "paused" | "stopped";

/**
 * @internal Surface a structural `AnimationGroup` needs from its host scene to be
 * stepped + weight-blended each frame. Typed structurally to avoid a Scene import
 * cycle.
 */
export interface StructuralAnimationHost {
    /** @internal Register a structural group to be stepped + blended each frame. */
    _registerStructuralGroup(group: AnimationGroup): void;
    /** @internal Re-run weighted blending across all structural groups. */
    _recomputeStructuralBlends(): void;
}

/**
 * @internal Surface a **loaded** glTF/.babylon `AnimationGroup` needs from its
 * host scene to enable Babylon Lite's weighted / additive skeletal blending.
 * Implemented structurally by the compat `Scene` to avoid an import cycle.
 */
export interface LoadedAnimationBlendHost {
    /**
     * @internal Route the scene's loaded Lite animation groups through a
     * scene-owned `AnimationManager` with blending enabled (idempotent).
     */
    _enableLoadedBlend(): void;
}

/**
 * Babylon.js `AnimationGroup` — a named collection of targeted animations with
 * playback state. This is the **single** `AnimationGroup` type, matching Babylon.js;
 * there is no separate "loaded" subtype. Two construction paths map onto Lite:
 *
 *  - **Structural** (`new AnimationGroup(name, scene?)`): a CPU-side collection
 *    built by ported code via `addTargetedAnimation`. When `start`ed it registers
 *    with the scene and is stepped each frame on the CPU; multiple groups that
 *    animate the same property are **weight-blended** (Babylon.js manual weighted
 *    / cross-fade blending) before the result is written to the target.
 *  - **Loaded** (`AnimationGroup._fromLite`, used to populate `scene.animationGroups`
 *    from glTF / `.babylon` clips): a thin wrapper over a Babylon Lite loaded group.
 *    The playback methods (`goToFrame`/`play`/`pause`/`stop`/`reset`) and the
 *    `from`/`to`/`isPlaying`/`speedRatio`/`loopAnimation`/`weight`/`animatables`
 *    accessors delegate to the Lite group so ported scenes can freeze/seek a
 *    loaded animation at a deterministic frame.
 */
export class AnimationGroup {
    public readonly targetedAnimations: Array<{ animation: Animation; target: unknown }> = [];
    public onAnimationGroupEndObservable?: () => void;

    /** @internal Babylon Lite loaded-group backing (set only on the loaded path). */
    public _lite?: LiteAnimationGroup;
    /** @internal Engine context used to drive Lite-backed playback. */
    private _engine?: EngineContext;
    /** @internal Host scene that owns the loaded-group blend manager (loaded path). */
    private _blendHost?: LoadedAnimationBlendHost;

    private _from = 0;
    private _to = 0;
    private _state: AnimationGroupState = "init";
    private _speedRatio = 1;
    private _loopAnimation = false;
    /** @internal Blend weight for the structural path (loaded path reads `_lite.weight`). */
    private _weight = 1;
    /** @internal Current frame for the structural path. */
    private _currentFrame = 0;
    /** @internal Host scene that steps + blends this structural group each frame. */
    private readonly _host?: StructuralAnimationHost;

    public constructor(
        public name: string,
        scene?: unknown
    ) {
        this._host = (scene as StructuralAnimationHost | undefined) ?? undefined;
    }

    /** @internal Build an `AnimationGroup` backed by a Babylon Lite loaded group. */
    public static _fromLite(lite: LiteAnimationGroup, engine: EngineContext, blendHost?: LoadedAnimationBlendHost): AnimationGroup {
        const group = new AnimationGroup(lite.name);
        group._lite = lite;
        group._engine = engine;
        group._blendHost = blendHost;
        return group;
    }

    /**
     * Babylon.js `AnimationGroup.MakeAnimationAdditive(group)` — convert a loaded
     * group into an additive layer (reference frame 0) and enable the scene's
     * weighted-blend manager. Returns the same group (Babylon Lite mutates in
     * place rather than cloning).
     */
    public static MakeAnimationAdditive(group: AnimationGroup): AnimationGroup {
        if (group._lite) {
            setAnimationAdditive(group._lite, { referenceFrame: 0 });
            group._blendHost?._enableLoadedBlend();
        }
        return group;
    }

    /** First frame of the clip. Always 0 for loaded clips. */
    public get from(): number {
        return this._lite ? 0 : this._from;
    }

    /** Last frame of the clip. */
    public get to(): number {
        return this._lite ? this._lite.duration * (this._lite.frameRate ?? 60) : this._to;
    }

    public get isPlaying(): boolean {
        return this._lite ? this._lite.isPlaying : this._state === "playing";
    }

    public get state(): AnimationGroupState {
        if (this._lite) {
            return this._lite.isPlaying ? "playing" : "paused";
        }
        return this._state;
    }

    public get speedRatio(): number {
        return this._lite ? this._lite.speedRatio : this._speedRatio;
    }
    public set speedRatio(value: number) {
        if (this._lite) {
            this._lite.speedRatio = value;
        } else {
            this._speedRatio = value;
        }
    }

    public get loopAnimation(): boolean {
        return this._lite ? this._lite.loopAnimation : this._loopAnimation;
    }
    public set loopAnimation(value: boolean) {
        if (this._lite) {
            this._lite.loopAnimation = value;
        } else {
            this._loopAnimation = value;
        }
    }

    public get weight(): number {
        return this._lite ? this._lite.weight : this._weight;
    }
    public set weight(value: number) {
        if (this._lite) {
            this._lite.weight = value;
            // A non-unit weight on a loaded clip means the scene must blend its
            // groups (Babylon.js manual weighted blend). Enable the scene's
            // weighted-blend manager (idempotent; no-op for the default weight 1).
            if (value !== 1) {
                this._blendHost?._enableLoadedBlend();
            }
        } else {
            this._weight = value;
            this._host?._recomputeStructuralBlends();
        }
    }

    /**
     * Babylon.js `AnimationGroup.animatables`. For loaded groups Babylon Lite drives
     * the whole group as one unit, so this surfaces a single animatable whose
     * `masterFrame` reflects the group's current frame. Structural groups built
     * without a running scene report no animatables.
     */
    public get animatables(): Array<{ masterFrame: number }> {
        if (this._lite) {
            const frameRate = this._lite.frameRate ?? 60;
            return [{ masterFrame: this._lite.currentTime * frameRate }];
        }
        return [];
    }

    public addTargetedAnimation(animation: Animation, target: unknown): { animation: Animation; target: unknown } {
        const entry = { animation, target };
        this.targetedAnimations.push(entry);
        this._from = Math.min(this._from, 0);
        this._to = Math.max(this._to, animation.getHighestFrame());
        return entry;
    }

    /**
     * Babylon.js `start(loop?, speedRatio?, from?, to?)`. On the structural path this
     * registers the group with its host scene, captures the targets' rest-pose
     * baselines, and begins CPU stepping + weight blending. On the loaded path it
     * seeks to `from` and plays — except a zero-length range (`from === to`) is a
     * **held single-frame pose** (e.g. an additive pose layer), which must hold
     * rather than play: Babylon Lite's group advance ignores the BJS play range and
     * would otherwise loop the (often ~2-frame) pose clip every frame, flickering.
     */
    public start(loop = true, speedRatio = 1, from?: number, to?: number): this {
        if (this._lite) {
            const frameRate = this._lite.frameRate ?? 60;
            if (from !== undefined) {
                this._lite.currentTime = from / frameRate;
            }
            this._lite.speedRatio = speedRatio;
            this._lite.loopAnimation = loop;
            if (from !== undefined && to !== undefined && from === to) {
                // Held single-frame pose — seek and hold (do not advance/loop).
                // `play` then `pause` clears Lite's internal `_stopped` flag (set by a
                // prior `stop()`) while leaving the clip paused, so the weighted mixer
                // still includes this group (a `_stopped` group is excluded from
                // blending, which would drop the whole shared-skeleton blend).
                playAnimation(this._lite);
                pauseAnimation(this._lite);
                return this;
            }
            return this.play(loop);
        }
        this._loopAnimation = loop;
        this._speedRatio = speedRatio;
        if (from !== undefined) {
            this._from = from;
        }
        if (to !== undefined) {
            this._to = to;
        }
        this._currentFrame = this._from;
        this._state = "playing";
        for (const { target, animation } of this.targetedAnimations) {
            captureOriginal(target as object, animation.targetProperty);
        }
        this._host?._registerStructuralGroup(this);
        this._host?._recomputeStructuralBlends();
        return this;
    }

    /** Babylon.js `goToFrame(frame)` — seek to a frame (loaded groups seek + hold via Lite; structural groups re-blend). */
    public goToFrame(frame: number): this {
        if (this._lite && this._engine) {
            liteGoToFrame(this._lite, frame, this._engine);
        } else {
            this._currentFrame = frame;
            this._host?._recomputeStructuralBlends();
        }
        return this;
    }

    public play(loop?: boolean): this {
        if (this._lite) {
            if (loop !== undefined) {
                this._lite.loopAnimation = loop;
            }
            playAnimation(this._lite);
        } else {
            this._state = "playing";
        }
        return this;
    }

    public pause(): this {
        if (this._lite) {
            pauseAnimation(this._lite);
        } else {
            this._state = "paused";
        }
        return this;
    }

    public stop(): this {
        if (this._lite) {
            stopAnimation(this._lite);
        } else {
            this._state = "stopped";
        }
        return this;
    }

    public reset(): this {
        if (this._lite && this._engine) {
            liteGoToFrame(this._lite, 0, this._engine);
        } else {
            this._state = "init";
        }
        return this;
    }

    /** @internal Whether this structural group currently contributes to blending (started, not stopped). */
    public _isStructuralActive(): boolean {
        return !this._lite && (this._state === "playing" || this._state === "paused");
    }

    /** @internal Advance a playing structural group's frame by `deltaMs` (with loop wrap). */
    public _advanceStructural(deltaMs: number): void {
        if (this._lite || this._state !== "playing") {
            return;
        }
        const fps = this.targetedAnimations[0]?.animation.framePerSecond ?? 60;
        this._currentFrame += (deltaMs / 1000) * fps * this._speedRatio;
        if (this._currentFrame > this._to) {
            if (this._loopAnimation) {
                const span = this._to - this._from || 1;
                this._currentFrame = this._from + ((this._currentFrame - this._from) % span);
            } else {
                this._currentFrame = this._to;
                this._state = "stopped";
            }
        }
    }

    /**
     * @internal Babylon.js manual weighted / cross-fade blending. Groups of
     * animations targeting the same (target, property) are mixed by weight: when
     * the total weight exceeds 1 the contributions are normalized, and when it is
     * below 1 the property's captured rest-pose baseline fills the remainder.
     */
    public static _blendStructuralGroups(groups: readonly AnimationGroup[]): void {
        interface Holder {
            target: object;
            path: string;
            total: number;
            contributions: Array<{ value: AnimValue; weight: number }>;
        }
        const holders = new Map<object, Map<string, Holder>>();
        for (const group of groups) {
            if (!group._isStructuralActive()) {
                continue;
            }
            const weight = group._weight;
            for (const { target, animation } of group.targetedAnimations) {
                const obj = target as object;
                const path = animation.targetProperty;
                const value = animation.evaluate(group._currentFrame);
                let perTarget = holders.get(obj);
                if (!perTarget) {
                    perTarget = new Map();
                    holders.set(obj, perTarget);
                }
                let holder = perTarget.get(path);
                if (!holder) {
                    holder = { target: obj, path, total: 0, contributions: [] };
                    perTarget.set(path, holder);
                }
                holder.total += weight;
                holder.contributions.push({ value, weight });
            }
        }
        for (const perTarget of holders.values()) {
            for (const holder of perTarget.values()) {
                const original = structuralOriginals.get(holder.target)?.get(holder.path) ?? 0;
                let final: AnimValue;
                if (holder.total === 0) {
                    final = original;
                } else {
                    let normalizer = 1;
                    if (holder.total < 1) {
                        final = scaleValue(original, 1 - holder.total);
                    } else {
                        normalizer = holder.total;
                        final = zeroLike(holder.contributions[0]!.value);
                    }
                    for (const c of holder.contributions) {
                        final = addValue(final, scaleValue(c.value, c.weight / normalizer));
                    }
                }
                applyAnimatedValue(holder.target, holder.path, final);
            }
        }
    }
}
