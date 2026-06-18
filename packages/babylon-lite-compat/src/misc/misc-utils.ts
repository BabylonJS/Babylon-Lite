/**
 * Babylon.js-compatible Misc utilities — the pure-JS subset that has no Babylon
 * Lite or GPU dependency: `SmartArray`, `StringDictionary`, `Tags`,
 * `PerformanceMonitor`, and `ColorGradient`/`FactorGradient`.
 */

/** A pre-sized, reusable array that tracks a logical `length` separately from capacity. */
export class SmartArray<T> {
    public data: Array<T | undefined>;
    public length = 0;

    public constructor(capacity: number) {
        this.data = new Array<T | undefined>(capacity);
    }

    public push(value: T): void {
        this.data[this.length++] = value;
        if (this.length > this.data.length) {
            this.data.length = this.length;
        }
    }

    public reset(): void {
        this.length = 0;
    }

    public concat(array: { length: number; data: Array<T | undefined> }): void {
        for (let i = 0; i < array.length; i++) {
            this.push(array.data[i] as T);
        }
    }

    public dispose(): void {
        this.reset();
        this.data.length = 0;
    }
}

/** A string-keyed dictionary with the Babylon.js `StringDictionary` surface. */
export class StringDictionary<T> {
    private _store: Record<string, T> = {};

    public get count(): number {
        return Object.keys(this._store).length;
    }

    public add(key: string, value: T): boolean {
        if (key in this._store) {
            return false;
        }
        this._store[key] = value;
        return true;
    }

    public set(key: string, value: T): boolean {
        if (!(key in this._store)) {
            return false;
        }
        this._store[key] = value;
        return true;
    }

    public get(key: string): T | undefined {
        return this._store[key];
    }

    public getOrAddWithFactory(key: string, factory: (key: string) => T): T {
        let value = this._store[key];
        if (value === undefined) {
            value = factory(key);
            this._store[key] = value;
        }
        return value;
    }

    public contains(key: string): boolean {
        return key in this._store;
    }

    public remove(key: string): boolean {
        if (key in this._store) {
            delete this._store[key];
            return true;
        }
        return false;
    }

    public clear(): void {
        this._store = {};
    }

    public forEach(callback: (key: string, value: T) => void): void {
        for (const key of Object.keys(this._store)) {
            callback(key, this._store[key]!);
        }
    }
}

interface Taggable {
    _tags?: Record<string, true>;
}

/** Babylon.js `Tags` — space-separated tag strings attached to arbitrary objects. */
export const Tags = {
    EnableFor(obj: Taggable): void {
        obj._tags ??= {};
    },

    HasTags(obj: Taggable): boolean {
        return !!obj._tags && Object.keys(obj._tags).length > 0;
    },

    AddTagsTo(obj: Taggable, tags: string): void {
        obj._tags ??= {};
        for (const tag of tags.split(/\s+/).filter(Boolean)) {
            obj._tags[tag] = true;
        }
    },

    RemoveTagsFrom(obj: Taggable, tags: string): void {
        if (!obj._tags) {
            return;
        }
        for (const tag of tags.split(/\s+/).filter(Boolean)) {
            delete obj._tags[tag];
        }
    },

    MatchesQuery(obj: Taggable, tag: string): boolean {
        return !!obj._tags && obj._tags[tag] === true;
    },

    GetTags(obj: Taggable): string[] {
        return obj._tags ? Object.keys(obj._tags) : [];
    },
};

/** Rolling FPS/frame-time monitor (Babylon.js `PerformanceMonitor`). */
export class PerformanceMonitor {
    private _samples: number[] = [];
    private _max: number;
    private _lastTime: number | null = null;
    private _enabled = true;

    public constructor(frameSampleSize = 30) {
        this._max = frameSampleSize;
    }

    public sampleFrame(timeMs: number = now()): void {
        if (!this._enabled) {
            return;
        }
        if (this._lastTime !== null) {
            const delta = timeMs - this._lastTime;
            this._samples.push(delta);
            if (this._samples.length > this._max) {
                this._samples.shift();
            }
        }
        this._lastTime = timeMs;
    }

    public get averageFrameTime(): number {
        if (this._samples.length === 0) {
            return 0;
        }
        return this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    }

    public get averageFPS(): number {
        const avg = this.averageFrameTime;
        return avg > 0 ? 1000 / avg : 0;
    }

    public get isSaturated(): boolean {
        return this._samples.length >= this._max;
    }

    public enable(): void {
        this._enabled = true;
    }

    public disable(): void {
        this._enabled = false;
    }

    public reset(): void {
        this._samples = [];
        this._lastTime = null;
    }
}

/** A gradient value bound to a [0, 1] position (Babylon.js `FactorGradient`). */
export class FactorGradient {
    public constructor(
        public gradient: number,
        public factor1: number,
        public factor2: number = factor1
    ) {}

    public getFactor(): number {
        return this.factor1;
    }
}

/** An RGBA color bound to a [0, 1] position (Babylon.js `ColorGradient`). */
export class ColorGradient {
    public constructor(
        public gradient: number,
        public color1: [number, number, number, number],
        public color2?: [number, number, number, number]
    ) {}
}

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Babylon.js `Logger` — level-gated console logging. */
export const Logger = {
    NoneLogLevel: 0,
    MessageLogLevel: 1,
    WarningLogLevel: 2,
    ErrorLogLevel: 4,
    AllLogLevel: 7,

    /** Current log-level bitmask. */
    LogLevels: 7,

    Log(message: string): void {
        if (this.LogLevels & this.MessageLogLevel) {
            // eslint-disable-next-line no-console
            console.log("BJS - " + message);
        }
    },

    Warn(message: string): void {
        if (this.LogLevels & this.WarningLogLevel) {
            console.warn("BJS - " + message);
        }
    },

    Error(message: string): void {
        if (this.LogLevels & this.ErrorLogLevel) {
            console.error("BJS - " + message);
        }
    },
};

/** Babylon.js `PrecisionDate` — high-resolution timestamp source. */
export const PrecisionDate = {
    get Now(): number {
        return now();
    },
};
