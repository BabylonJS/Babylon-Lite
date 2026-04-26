/** ObservableVec3 — a 3-component vector with setters that notify on change.
 *  Used for Mesh position/rotation/scaling so the render system
 *  can detect transform changes via a version counter.
 *  V8 inlines trivial getters/setters — zero overhead vs raw properties. */

import type { Vec3 } from "./types.js";

export class ObservableVec3 implements Vec3 {
    private _x: number;
    private _y: number;
    private _z: number;
    private readonly _onDirty: () => void;

    constructor(x: number, y: number, z: number, onDirty: () => void) {
        this._x = x;
        this._y = y;
        this._z = z;
        this._onDirty = onDirty;
    }

    get x(): number {
        return this._x;
    }
    set x(v: number) {
        if (this._x !== v) {
            this._x = v;
            this._onDirty();
        }
    }

    get y(): number {
        return this._y;
    }
    set y(v: number) {
        if (this._y !== v) {
            this._y = v;
            this._onDirty();
        }
    }

    get z(): number {
        return this._z;
    }
    set z(v: number) {
        if (this._z !== v) {
            this._z = v;
            this._onDirty();
        }
    }

    /** Bulk set — one dirty notification instead of three. */
    set(x: number, y: number, z: number): void {
        this._x = x;
        this._y = y;
        this._z = z;
        this._onDirty();
    }

    /** Copy values from another vector. */
    copyFrom(v: Vec3): void {
        this.set(v.x, v.y, v.z);
    }

    /** Copy into a Float32Array at offset. */
    toArray(out: Float32Array, offset = 0): void {
        out[offset] = this._x;
        out[offset + 1] = this._y;
        out[offset + 2] = this._z;
    }
}
