/**
 * Babylon.js-compatible `Animation` keyframe model + `AnimationGroup`.
 *
 * `Animation` is a pure-JS keyframe container with CPU evaluation (`evaluate`),
 * the Babylon.js data-type / loop-mode constants, and `setKeys`/`getKeys`. This
 * is fully testable without a GPU. `AnimationGroup` provides the structural
 * grouping/playback-state surface; frame-accurate playback is driven through the
 * native Babylon Lite animation manager when wired to a scene (not modelled here).
 */

import { goToFrame as liteGoToFrame, playAnimation, pauseAnimation, stopAnimation } from "babylon-lite";
import type { AnimationGroup as LiteAnimationGroup, EngineContext } from "babylon-lite";

export interface IAnimationKey {
    frame: number;
    value: number | number[];
}

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
            if (frame >= a.frame && frame <= b.frame) {
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
    public speedRatio = 1;
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
 * Babylon.js `AnimationGroup` — a named collection of targeted animations with
 * playback state. This is the **single** `AnimationGroup` type, matching Babylon.js;
 * there is no separate "loaded" subtype. Two construction paths map onto Lite:
 *
 *  - **Structural** (`new AnimationGroup(name, scene?)`): a CPU-side collection
 *    built by ported code via `addTargetedAnimation`; playback state is tracked
 *    structurally (frame stepping is delegated to the native manager when bound).
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

    private _from = 0;
    private _to = 0;
    private _state: AnimationGroupState = "init";
    private _speedRatio = 1;
    private _loopAnimation = false;

    public constructor(
        public name: string,
        _scene?: unknown
    ) {}

    /** @internal Build an `AnimationGroup` backed by a Babylon Lite loaded group. */
    public static _fromLite(lite: LiteAnimationGroup, engine: EngineContext): AnimationGroup {
        const group = new AnimationGroup(lite.name);
        group._lite = lite;
        group._engine = engine;
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
        return this._lite ? this._lite.weight : 1;
    }
    public set weight(value: number) {
        if (this._lite) {
            this._lite.weight = value;
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
            return [{ masterFrame: this._lite.currentFrame * frameRate }];
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

    /** Babylon.js `goToFrame(frame)` — seek to a frame (loaded groups seek + hold via Lite). */
    public goToFrame(frame: number): this {
        if (this._lite && this._engine) {
            liteGoToFrame(this._lite, frame, this._engine);
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
}
