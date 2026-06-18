/** Babylon.js-compatible curve/path helpers: `Angle`, `Curve3`, `Path3D` (pure JS). */

import { Vector3 } from "./vector.js";

export class Angle {
    public constructor(private readonly _radians: number) {}

    public radians(): number {
        return this._radians;
    }

    public degrees(): number {
        return (this._radians * 180) / Math.PI;
    }

    public static FromRadians(radians: number): Angle {
        return new Angle(radians);
    }

    public static FromDegrees(degrees: number): Angle {
        return new Angle((degrees * Math.PI) / 180);
    }
}

/** A 3D curve built from an ordered list of points. */
export class Curve3 {
    public constructor(private readonly _points: Vector3[]) {}

    public getPoints(): Vector3[] {
        return this._points;
    }

    /** Total polyline length along the curve points. */
    public length(): number {
        let total = 0;
        for (let i = 1; i < this._points.length; i++) {
            total += Vector3.Distance(this._points[i]!, this._points[i - 1]!);
        }
        return total;
    }

    /** Concatenate another curve (dropping the duplicated join point). */
    public continue(curve: Curve3): Curve3 {
        const points = this._points.slice();
        const other = curve.getPoints();
        for (let i = 1; i < other.length; i++) {
            points.push(other[i]!.clone());
        }
        return new Curve3(points);
    }

    /** Quadratic Bézier from `v0` → `v2` with control `v1`, sampled `nbPoints` times. */
    public static CreateQuadraticBezier(v0: Vector3, v1: Vector3, v2: Vector3, nbPoints: number): Curve3 {
        const count = Math.max(nbPoints, 2);
        const points: Vector3[] = [];
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            const u = 1 - t;
            const x = u * u * v0.x + 2 * u * t * v1.x + t * t * v2.x;
            const y = u * u * v0.y + 2 * u * t * v1.y + t * t * v2.y;
            const z = u * u * v0.z + 2 * u * t * v1.z + t * t * v2.z;
            points.push(new Vector3(x, y, z));
        }
        return new Curve3(points);
    }

    /** Cubic Bézier from `v0` → `v3` with controls `v1`, `v2`, sampled `nbPoints` times. */
    public static CreateCubicBezier(v0: Vector3, v1: Vector3, v2: Vector3, v3: Vector3, nbPoints: number): Curve3 {
        const count = Math.max(nbPoints, 2);
        const points: Vector3[] = [];
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            const u = 1 - t;
            const w0 = u * u * u;
            const w1 = 3 * u * u * t;
            const w2 = 3 * u * t * t;
            const w3 = t * t * t;
            points.push(new Vector3(w0 * v0.x + w1 * v1.x + w2 * v2.x + w3 * v3.x, w0 * v0.y + w1 * v1.y + w2 * v2.y + w3 * v3.y, w0 * v0.z + w1 * v1.z + w2 * v2.z + w3 * v3.z));
        }
        return new Curve3(points);
    }
}

/** A 3D path with cumulative-distance queries over its points. */
export class Path3D {
    private readonly _curve: Vector3[];
    private readonly _distances: number[] = [];
    private _length = 0;

    public constructor(points: Vector3[]) {
        this._curve = points.map((p) => p.clone());
        this._distances[0] = 0;
        for (let i = 1; i < this._curve.length; i++) {
            this._length += Vector3.Distance(this._curve[i]!, this._curve[i - 1]!);
            this._distances[i] = this._length;
        }
    }

    public getCurve(): Vector3[] {
        return this._curve;
    }

    public getPoints(): Vector3[] {
        return this._curve;
    }

    public length(): number {
        return this._length;
    }

    /** Distances of each point from the path start, normalized to [0, 1] when `length > 0`. */
    public getDistances(): number[] {
        return this._distances;
    }
}
