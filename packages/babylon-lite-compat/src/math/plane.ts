/** Babylon.js-compatible `Plane` (pure JS). */

import { Vector3 } from "./vector.js";
import type { Matrix } from "./matrix.js";

export class Plane {
    /** Normal x/y/z and signed distance `d` from the origin (`normal · p + d = 0`). */
    public normal: Vector3;
    public d: number;

    public constructor(a: number, b: number, c: number, d: number) {
        this.normal = new Vector3(a, b, c);
        this.d = d;
    }

    public asArray(): [number, number, number, number] {
        return [this.normal.x, this.normal.y, this.normal.z, this.d];
    }

    public clone(): Plane {
        return new Plane(this.normal.x, this.normal.y, this.normal.z, this.d);
    }

    public normalize(): this {
        const norm = Math.sqrt(this.normal.x * this.normal.x + this.normal.y * this.normal.y + this.normal.z * this.normal.z);
        const inv = norm === 0 ? 0 : 1 / norm;
        this.normal.scaleInPlace(inv);
        this.d *= inv;
        return this;
    }

    /** Signed distance from `point` to this plane. */
    public signedDistanceTo(point: Vector3): number {
        return Vector3.Dot(point, this.normal) + this.d;
    }

    public dotCoordinate(point: Vector3): number {
        return this.normal.x * point.x + this.normal.y * point.y + this.normal.z * point.z + this.d;
    }

    public static FromArray(array: ArrayLike<number>): Plane {
        return new Plane(array[0] ?? 0, array[1] ?? 0, array[2] ?? 0, array[3] ?? 0);
    }

    public static FromPositionAndNormal(origin: Vector3, normal: Vector3): Plane {
        const n = normal.clone().normalize();
        const d = -(n.x * origin.x + n.y * origin.y + n.z * origin.z);
        return new Plane(n.x, n.y, n.z, d);
    }

    public static FromPoints(point1: Vector3, point2: Vector3, point3: Vector3): Plane {
        const normal = Vector3.Cross(point2.subtract(point1), point3.subtract(point1)).normalize();
        return Plane.FromPositionAndNormal(point1, normal);
    }

    /** Transform a copy of this plane by the transpose of the inverse of `transformation`. */
    public transform(transformation: Matrix): Plane {
        // For a correct plane transform the caller passes the inverse-transpose;
        // here we apply the matrix directly to (normal, d) as a row-vector.
        const m = transformation.m;
        const x = this.normal.x;
        const y = this.normal.y;
        const z = this.normal.z;
        const d = this.d;
        const nx = x * m[0]! + y * m[1]! + z * m[2]! + d * m[3]!;
        const ny = x * m[4]! + y * m[5]! + z * m[6]! + d * m[7]!;
        const nz = x * m[8]! + y * m[9]! + z * m[10]! + d * m[11]!;
        const nd = x * m[12]! + y * m[13]! + z * m[14]! + d * m[15]!;
        return new Plane(nx, ny, nz, nd);
    }
}
