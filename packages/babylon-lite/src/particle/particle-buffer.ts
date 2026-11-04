/**
 * Data-oriented particle storage (Struct-of-Arrays).
 *
 * A particle is an index in `[0, alive)`. Every attribute is a pre-sized typed-array column owned by the
 * buffer, so the per-frame update loop reads and writes array slots by index and never allocates: the hot
 * path is zero-garbage by construction, and there is no per-particle object (hence no hidden-class or
 * monomorphism concern).
 *
 * Base simulation columns and standard NPE render/lifecycle columns are always present. {@link column}
 * adds only optional feature state. Feature code remains in its owning module so an unused optional
 * feature adds neither columns nor runtime module bytes.
 */

/** A particle column: one typed-array slot per particle index. */
export type ParticleColumn = Float64Array | Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;

/** Pure-state Struct-of-Arrays particle store. Behaviour is provided by the standalone functions below. */
export interface ParticleBuffer {
    /** Maximum simultaneously-alive particles; every column is sized to this. */
    readonly capacity: number;
    /** Number of live particles. Live slots are `[0, alive)`. */
    alive: number;

    /** World-space position. */
    readonly posX: Float32Array;
    readonly posY: Float32Array;
    readonly posZ: Float32Array;
    /** Movement direction (advances position each step). */
    readonly dirX: Float32Array;
    readonly dirY: Float32Array;
    readonly dirZ: Float32Array;
    /**
     * Seconds since birth. Float64: age accumulates every step and drives the integer sprite cell index and
     * the exact death step, so it is kept at oracle precision (float32 accumulation drifts a cell at
     * boundaries).
     */
    readonly age: Float64Array;
    /** Total lifespan in seconds. Float64 to match `age` for exact lifecycle/cell-index parity. */
    readonly lifeTime: Float64Array;
    /** Unique id assigned at spawn (stable ordering / keys). */
    readonly id: Uint32Array;

    /** Standard NPE render and lifecycle state. */
    readonly size: Float32Array;
    readonly angle: Float32Array;
    readonly scaleX: Float32Array;
    readonly scaleY: Float32Array;
    readonly colorR: Float32Array;
    readonly colorG: Float32Array;
    readonly colorB: Float32Array;
    readonly colorA: Float32Array;
    readonly colorStepR: Float32Array;
    readonly colorStepG: Float32Array;
    readonly colorStepB: Float32Array;
    readonly colorStepA: Float32Array;

    /** @internal Optional feature columns by name; allocated on demand by {@link column}. */
    readonly _columns: Map<string, ParticleColumn>;
    /** @internal Every column (base + standard + optional), copied slot-wise on swap-remove. */
    readonly _all: ParticleColumn[];
    /** @internal Monotonic id source. */
    _nextId: number;
}

/** Create a particle buffer with all built-in columns sized to `capacity`. */
export function createParticleBuffer(capacity: number): ParticleBuffer {
    const posX = new Float32Array(capacity);
    const posY = new Float32Array(capacity);
    const posZ = new Float32Array(capacity);
    const dirX = new Float32Array(capacity);
    const dirY = new Float32Array(capacity);
    const dirZ = new Float32Array(capacity);
    const age = new Float64Array(capacity);
    const lifeTime = new Float64Array(capacity);
    const id = new Uint32Array(capacity);
    const size = new Float32Array(capacity);
    const angle = new Float32Array(capacity);
    const scaleX = new Float32Array(capacity);
    const scaleY = new Float32Array(capacity);
    const colorR = new Float32Array(capacity);
    const colorG = new Float32Array(capacity);
    const colorB = new Float32Array(capacity);
    const colorA = new Float32Array(capacity);
    const colorStepR = new Float32Array(capacity);
    const colorStepG = new Float32Array(capacity);
    const colorStepB = new Float32Array(capacity);
    const colorStepA = new Float32Array(capacity);
    return {
        capacity,
        alive: 0,
        posX,
        posY,
        posZ,
        dirX,
        dirY,
        dirZ,
        age,
        lifeTime,
        id,
        size,
        angle,
        scaleX,
        scaleY,
        colorR,
        colorG,
        colorB,
        colorA,
        colorStepR,
        colorStepG,
        colorStepB,
        colorStepA,
        _columns: new Map(),
        _all: [posX, posY, posZ, dirX, dirY, dirZ, age, lifeTime, id, size, angle, scaleX, scaleY, colorR, colorG, colorB, colorA, colorStepR, colorStepG, colorStepB, colorStepA],
        _nextId: 0,
    };
}

/**
 * Get (or lazily allocate) an optional feature column by name. The first caller allocates a typed array of the
 * buffer's capacity and registers it for swap-remove; later callers with the same name share it. A buffer
 * whose systems never request a given column never allocates it — this is what makes unused features free.
 */
export function column<T extends ParticleColumn>(buffer: ParticleBuffer, name: string, ctor: new (length: number) => T): T {
    const existing = buffer._columns.get(name);
    if (existing) {
        return existing as T;
    }
    const created = new ctor(buffer.capacity);
    buffer._columns.set(name, created);
    buffer._all.push(created);
    return created;
}

/**
 * Reserve a slot for a new particle and return its index, or `-1` when the buffer is full. Assigns a fresh
 * id and zeroes `age`; the caller's creation steps must fill every other field they own.
 */
export function spawnParticle(buffer: ParticleBuffer): number {
    if (buffer.alive >= buffer.capacity) {
        return -1;
    }
    const i = buffer.alive++;
    buffer.id[i] = buffer._nextId++;
    buffer.age[i] = 0;
    return i;
}

/**
 * Recycle a dead particle by swap-remove: copy the last live particle into slot `i` across every column and
 * shrink the live range. Zero allocation; O(columns) copies per death.
 */
export function killParticle(buffer: ParticleBuffer, i: number): void {
    const last = --buffer.alive;
    if (i !== last) {
        const all = buffer._all;
        for (let c = 0; c < all.length; c++) {
            const col = all[c]!;
            col[i] = col[last]!;
        }
    }
}
