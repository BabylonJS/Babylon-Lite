/**
 * Data-oriented particle storage (Struct-of-Arrays) — SPIKE.
 *
 * A particle is an index in `[0, alive)`. Every attribute is a pre-sized typed-array column owned by the
 * buffer, so the per-frame update loop reads and writes array slots by index and never allocates: the hot
 * path is zero-garbage by construction, and there is no per-particle object (hence no hidden-class or
 * monomorphism concern).
 *
 * Base columns (position, direction, age, lifeTime, id) are always present. Every other attribute is a
 * *feature column* allocated on demand via {@link column}: a system that does not use a feature allocates
 * no column for it (zero memory), and that feature's code lives in its own module (zero bundle when the
 * feature is unused). This is the mechanism that lets particle systems avoid paying for features they do
 * not use while keeping the update loop allocation-free.
 */

/** A particle column: one typed-array slot per particle index. */
export type ParticleColumn = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;

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
    /** Seconds since birth. */
    readonly age: Float32Array;
    /** Total lifespan in seconds. */
    readonly lifeTime: Float32Array;
    /** Unique id assigned at spawn (stable ordering / keys). */
    readonly id: Uint32Array;

    /** @internal Feature columns by name; allocated on demand by {@link column}. */
    readonly _columns: Map<string, ParticleColumn>;
    /** @internal Every column (base + feature), copied slot-wise on swap-remove. */
    readonly _all: ParticleColumn[];
    /** @internal Monotonic id source. */
    _nextId: number;
}

/** Create a particle buffer with all base columns sized to `capacity`. */
export function createParticleBuffer(capacity: number): ParticleBuffer {
    const posX = new Float32Array(capacity);
    const posY = new Float32Array(capacity);
    const posZ = new Float32Array(capacity);
    const dirX = new Float32Array(capacity);
    const dirY = new Float32Array(capacity);
    const dirZ = new Float32Array(capacity);
    const age = new Float32Array(capacity);
    const lifeTime = new Float32Array(capacity);
    const id = new Uint32Array(capacity);
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
        _columns: new Map(),
        _all: [posX, posY, posZ, dirX, dirY, dirZ, age, lifeTime, id],
        _nextId: 0,
    };
}

/**
 * Get (or lazily allocate) a feature column by name. The first caller allocates a typed array of the
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
 * id and zeroes `age`; the caller's creation steps fill the remaining columns (mirroring the object system,
 * where the creation queue sets every field on a freshly pooled particle).
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
