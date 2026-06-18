/** Babylon.js-compatible `Ray` (pure JS). */

import { Vector3 } from "./vector.js";
import type { Plane } from "./plane.js";

export class Ray {
    public origin: Vector3;
    public direction: Vector3;
    public length: number;

    public constructor(origin: Vector3, direction: Vector3, length: number = Number.MAX_VALUE) {
        this.origin = origin;
        this.direction = direction;
        this.length = length;
    }

    public clone(): Ray {
        return new Ray(this.origin.clone(), this.direction.clone(), this.length);
    }

    /** Distance at which this ray crosses `plane`, or `null` if parallel / behind. */
    public intersectsPlane(plane: Plane): number | null {
        const dot = Vector3.Dot(plane.normal, this.direction);
        if (Math.abs(dot) < 1e-9) {
            return null;
        }
        const t = -(Vector3.Dot(plane.normal, this.origin) + plane.d) / dot;
        return t < 0 ? null : t;
    }

    /** True if this ray passes within `sphereRadius` of `spherePosition`. */
    public intersectsSphere(spherePosition: Vector3, sphereRadius: number): boolean {
        const x = spherePosition.x - this.origin.x;
        const y = spherePosition.y - this.origin.y;
        const z = spherePosition.z - this.origin.z;
        const pyth = x * x + y * y + z * z;
        const rr = sphereRadius * sphereRadius;
        if (pyth <= rr) {
            return true;
        }
        const dot = x * this.direction.x + y * this.direction.y + z * this.direction.z;
        if (dot < 0) {
            return false;
        }
        const temp = pyth - dot * dot;
        return temp <= rr;
    }

    public static Zero(): Ray {
        return new Ray(Vector3.Zero(), new Vector3(0, 0, 1), Number.MAX_VALUE);
    }

    public static CreateNew(x: number, y: number, z: number, dx: number, dy: number, dz: number, length = Number.MAX_VALUE): Ray {
        return new Ray(new Vector3(x, y, z), new Vector3(dx, dy, dz), length);
    }
}
