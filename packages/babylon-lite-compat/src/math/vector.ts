/**
 * Babylon.js-compatible vector classes (`Vector2`, `Vector3`, `Vector4`).
 *
 * These are mutable classes backed by plain `x`/`y`/`z`/`w` fields. Because a
 * `Vector3` is structurally `{ x, y, z }`, it can be passed directly anywhere
 * the Babylon Lite API expects a `Vec3`. For APIs that want a tuple, use
 * `asArray()`.
 */

import type { Matrix } from "./matrix.js";

export class Vector2 {
    public constructor(
        public x: number = 0,
        public y: number = 0
    ) {}

    public set(x: number, y: number): this {
        this.x = x;
        this.y = y;
        return this;
    }

    public copyFrom(source: Vector2): this {
        this.x = source.x;
        this.y = source.y;
        return this;
    }

    public copyFromFloats(x: number, y: number): this {
        this.x = x;
        this.y = y;
        return this;
    }

    public add(other: Vector2): Vector2 {
        return new Vector2(this.x + other.x, this.y + other.y);
    }

    public addInPlace(other: Vector2): this {
        this.x += other.x;
        this.y += other.y;
        return this;
    }

    public subtract(other: Vector2): Vector2 {
        return new Vector2(this.x - other.x, this.y - other.y);
    }

    public scale(scale: number): Vector2 {
        return new Vector2(this.x * scale, this.y * scale);
    }

    public scaleInPlace(scale: number): this {
        this.x *= scale;
        this.y *= scale;
        return this;
    }

    public length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y);
    }

    public lengthSquared(): number {
        return this.x * this.x + this.y * this.y;
    }

    public normalize(): this {
        const len = this.length();
        if (len !== 0) {
            this.x /= len;
            this.y /= len;
        }
        return this;
    }

    public clone(): Vector2 {
        return new Vector2(this.x, this.y);
    }

    public equals(other: Vector2): boolean {
        return this.x === other.x && this.y === other.y;
    }

    public asArray(): [number, number] {
        return [this.x, this.y];
    }

    public static Zero(): Vector2 {
        return new Vector2(0, 0);
    }

    public static One(): Vector2 {
        return new Vector2(1, 1);
    }

    public static Dot(a: Vector2, b: Vector2): number {
        return a.x * b.x + a.y * b.y;
    }
}

export class Vector3 {
    public constructor(
        public x: number = 0,
        public y: number = 0,
        public z: number = 0
    ) {}

    public set(x: number, y: number, z: number): this {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }

    public setAll(value: number): this {
        this.x = this.y = this.z = value;
        return this;
    }

    public copyFrom(source: Vector3): this {
        this.x = source.x;
        this.y = source.y;
        this.z = source.z;
        return this;
    }

    public copyFromFloats(x: number, y: number, z: number): this {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }

    public add(other: Vector3): Vector3 {
        return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
    }

    public addInPlace(other: Vector3): this {
        this.x += other.x;
        this.y += other.y;
        this.z += other.z;
        return this;
    }

    public addInPlaceFromFloats(x: number, y: number, z: number): this {
        this.x += x;
        this.y += y;
        this.z += z;
        return this;
    }

    public subtract(other: Vector3): Vector3 {
        return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
    }

    public subtractInPlace(other: Vector3): this {
        this.x -= other.x;
        this.y -= other.y;
        this.z -= other.z;
        return this;
    }

    public multiply(other: Vector3): Vector3 {
        return new Vector3(this.x * other.x, this.y * other.y, this.z * other.z);
    }

    public scale(scale: number): Vector3 {
        return new Vector3(this.x * scale, this.y * scale, this.z * scale);
    }

    public scaleInPlace(scale: number): this {
        this.x *= scale;
        this.y *= scale;
        this.z *= scale;
        return this;
    }

    public negate(): Vector3 {
        return new Vector3(-this.x, -this.y, -this.z);
    }

    public length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }

    public lengthSquared(): number {
        return this.x * this.x + this.y * this.y + this.z * this.z;
    }

    public normalize(): this {
        const len = this.length();
        if (len !== 0) {
            this.x /= len;
            this.y /= len;
            this.z /= len;
        }
        return this;
    }

    public clone(): Vector3 {
        return new Vector3(this.x, this.y, this.z);
    }

    public equals(other: Vector3): boolean {
        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    public equalsWithEpsilon(other: Vector3, epsilon = 1e-6): boolean {
        return Math.abs(this.x - other.x) <= epsilon && Math.abs(this.y - other.y) <= epsilon && Math.abs(this.z - other.z) <= epsilon;
    }

    public asArray(): [number, number, number] {
        return [this.x, this.y, this.z];
    }

    public toArray(array: number[], index = 0): this {
        array[index] = this.x;
        array[index + 1] = this.y;
        array[index + 2] = this.z;
        return this;
    }

    public static Zero(): Vector3 {
        return new Vector3(0, 0, 0);
    }

    public static One(): Vector3 {
        return new Vector3(1, 1, 1);
    }

    public static Up(): Vector3 {
        return new Vector3(0, 1, 0);
    }

    public static Down(): Vector3 {
        return new Vector3(0, -1, 0);
    }

    public static Forward(): Vector3 {
        return new Vector3(0, 0, 1);
    }

    public static Backward(): Vector3 {
        return new Vector3(0, 0, -1);
    }

    public static Right(): Vector3 {
        return new Vector3(1, 0, 0);
    }

    public static Left(): Vector3 {
        return new Vector3(-1, 0, 0);
    }

    public static FromArray(array: ArrayLike<number>, offset = 0): Vector3 {
        return new Vector3(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
    }

    public static Dot(a: Vector3, b: Vector3): number {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    public static Cross(a: Vector3, b: Vector3): Vector3 {
        return new Vector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }

    public static Distance(a: Vector3, b: Vector3): number {
        return Math.sqrt(Vector3.DistanceSquared(a, b));
    }

    public static DistanceSquared(a: Vector3, b: Vector3): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return dx * dx + dy * dy + dz * dz;
    }

    public static Lerp(start: Vector3, end: Vector3, amount: number): Vector3 {
        return new Vector3(start.x + (end.x - start.x) * amount, start.y + (end.y - start.y) * amount, start.z + (end.z - start.z) * amount);
    }

    /** Midpoint between two vectors. */
    public static Center(a: Vector3, b: Vector3): Vector3 {
        return new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    }

    /** Midpoint between two vectors, written into `ref`. */
    public static CenterToRef(a: Vector3, b: Vector3, ref: Vector3): Vector3 {
        return ref.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    }

    public static Normalize(vector: Vector3): Vector3 {
        return vector.clone().normalize();
    }

    public static Minimize(a: Vector3, b: Vector3): Vector3 {
        return new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
    }

    public static Maximize(a: Vector3, b: Vector3): Vector3 {
        return new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
    }

    /** Transform a coordinate (point) by a matrix using the row-vector convention. */
    public static TransformCoordinates(vector: Vector3, transformation: Matrix): Vector3 {
        const m = transformation.m;
        const x = vector.x;
        const y = vector.y;
        const z = vector.z;
        const rx = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
        const ry = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
        const rz = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
        const rw = 1 / (x * m[3]! + y * m[7]! + z * m[11]! + m[15]!);
        return new Vector3(rx * rw, ry * rw, rz * rw);
    }

    /** Transform a direction (normal) by a matrix, ignoring translation. */
    public static TransformNormal(vector: Vector3, transformation: Matrix): Vector3 {
        const m = transformation.m;
        const x = vector.x;
        const y = vector.y;
        const z = vector.z;
        return new Vector3(x * m[0]! + y * m[4]! + z * m[8]!, x * m[1]! + y * m[5]! + z * m[9]!, x * m[2]! + y * m[6]! + z * m[10]!);
    }
}

/** Minimal live 3-component backing (Babylon Lite's `ObservableVec3`). */
interface LiveVec3 {
    x: number;
    y: number;
    z: number;
}

/**
 * @internal A `Vector3` whose `x`/`y`/`z` read and write **through** to a live
 * Babylon Lite vector (`ObservableVec3`). This lets compat code expose
 * `mesh.position` / `rotation` / `scaling` as a real `Vector3` — so inherited
 * in-place methods (`scaleInPlace`, `addInPlace`, `set`, …) mutate the Lite node
 * and trigger its dirty tracking, matching Babylon.js's live-transform semantics.
 *
 * The accessors are installed with `Object.defineProperty` **after** `super()`,
 * which redefines the own `x`/`y`/`z` data properties the base constructor created
 * (parameter properties). This is required under `useDefineForClassFields` (ES2022),
 * where overriding the accessors via a subclass field/prototype alone would be
 * shadowed by the base's own data properties.
 */
class LiteBackedVector3 extends Vector3 {
    public constructor(lite: LiveVec3) {
        super(0, 0, 0);
        Object.defineProperty(this, "x", { enumerable: true, configurable: true, get: () => lite.x, set: (v: number) => (lite.x = v) });
        Object.defineProperty(this, "y", { enumerable: true, configurable: true, get: () => lite.y, set: (v: number) => (lite.y = v) });
        Object.defineProperty(this, "z", { enumerable: true, configurable: true, get: () => lite.z, set: (v: number) => (lite.z = v) });
    }
}

/** One stable proxy per Lite vector, so `mesh.position === mesh.position` (Babylon.js identity parity). */
const _liteVec3Proxies = new WeakMap<object, Vector3>();

/**
 * @internal Return the cached write-through `Vector3` proxy over a Lite
 * `ObservableVec3` (creating it on first use). Stable identity per Lite vector.
 */
export function liteBackedVector3(lite: LiveVec3): Vector3 {
    let proxy = _liteVec3Proxies.get(lite as object);
    if (!proxy) {
        proxy = new LiteBackedVector3(lite);
        _liteVec3Proxies.set(lite as object, proxy);
    }
    return proxy;
}

export class Vector4 {
    public constructor(
        public x: number = 0,
        public y: number = 0,
        public z: number = 0,
        public w: number = 0
    ) {}

    public set(x: number, y: number, z: number, w: number): this {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
        return this;
    }

    public copyFrom(source: Vector4): this {
        this.x = source.x;
        this.y = source.y;
        this.z = source.z;
        this.w = source.w;
        return this;
    }

    public add(other: Vector4): Vector4 {
        return new Vector4(this.x + other.x, this.y + other.y, this.z + other.z, this.w + other.w);
    }

    public scale(scale: number): Vector4 {
        return new Vector4(this.x * scale, this.y * scale, this.z * scale, this.w * scale);
    }

    public length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    }

    public clone(): Vector4 {
        return new Vector4(this.x, this.y, this.z, this.w);
    }

    public equals(other: Vector4): boolean {
        return this.x === other.x && this.y === other.y && this.z === other.z && this.w === other.w;
    }

    public asArray(): [number, number, number, number] {
        return [this.x, this.y, this.z, this.w];
    }

    public static Zero(): Vector4 {
        return new Vector4(0, 0, 0, 0);
    }
}
