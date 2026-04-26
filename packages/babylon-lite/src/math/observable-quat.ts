/** ObservableQuat — a 4-component quaternion with setters that notify on change.
 *  Used for TransformNode.rotationQuaternion so the hierarchy system
 *  can detect rotation changes via a version counter.
 *  Same pattern as ObservableVec3. V8 inlines trivial getters/setters. */

import type { Quat } from "./types.js";

export class ObservableQuat implements Quat {
    private _x: number;
    private _y: number;
    private _z: number;
    private _w: number;
    private readonly _onDirty: () => void;

    constructor(x: number, y: number, z: number, w: number, onDirty: () => void) {
        this._x = x;
        this._y = y;
        this._z = z;
        this._w = w;
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

    get w(): number {
        return this._w;
    }
    set w(v: number) {
        if (this._w !== v) {
            this._w = v;
            this._onDirty();
        }
    }

    /** Bulk set — one dirty notification instead of four. */
    set(x: number, y: number, z: number, w: number): void {
        this._x = x;
        this._y = y;
        this._z = z;
        this._w = w;
        this._onDirty();
    }

    /** Copy values from another quaternion. */
    copyFrom(q: Quat): void {
        this.set(q.x, q.y, q.z, q.w);
    }

    /** Copy into a Float32Array at offset. */
    toArray(out: Float32Array, offset = 0): void {
        out[offset] = this._x;
        out[offset + 1] = this._y;
        out[offset + 2] = this._z;
        out[offset + 3] = this._w;
    }
}
