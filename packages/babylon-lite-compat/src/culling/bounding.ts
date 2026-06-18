/**
 * Babylon.js-compatible bounding volumes (`BoundingBox`, `BoundingSphere`,
 * `BoundingInfo`) — pure JS over the compat math types.
 */

import { Vector3 } from "../math/vector.js";
import type { Matrix } from "../math/matrix.js";

export class BoundingSphere {
    public center: Vector3;
    public radius: number;
    public minimum: Vector3;
    public maximum: Vector3;

    public constructor(min: Vector3, max: Vector3) {
        this.minimum = min.clone();
        this.maximum = max.clone();
        this.center = Vector3.Lerp(min, max, 0.5);
        this.radius = max.subtract(min).length() * 0.5;
    }

    public intersectsPoint(point: Vector3): boolean {
        return Vector3.DistanceSquared(this.center, point) <= this.radius * this.radius;
    }

    public static Intersects(a: BoundingSphere, b: BoundingSphere): boolean {
        const r = a.radius + b.radius;
        return Vector3.DistanceSquared(a.center, b.center) <= r * r;
    }
}

export class BoundingBox {
    public minimum: Vector3;
    public maximum: Vector3;
    public center: Vector3;
    public extendSize: Vector3;
    /** World-space AABB corners. Equal to `minimum`/`maximum` when the box is
     *  already built in world space (as the loader's `getBoundingInfo` does). */
    public minimumWorld: Vector3;
    public maximumWorld: Vector3;
    /** The 8 corner points (min/max combinations). */
    public vectors: Vector3[];

    public constructor(min: Vector3, max: Vector3) {
        this.minimum = min.clone();
        this.maximum = max.clone();
        this.minimumWorld = min.clone();
        this.maximumWorld = max.clone();
        this.center = Vector3.Lerp(min, max, 0.5);
        this.extendSize = max.subtract(min).scale(0.5);
        this.vectors = [
            new Vector3(min.x, min.y, min.z),
            new Vector3(max.x, max.y, max.z),
            new Vector3(max.x, min.y, min.z),
            new Vector3(min.x, max.y, min.z),
            new Vector3(min.x, min.y, max.z),
            new Vector3(max.x, max.y, min.z),
            new Vector3(min.x, max.y, max.z),
            new Vector3(max.x, min.y, max.z),
        ];
    }

    public intersectsPoint(point: Vector3): boolean {
        return (
            point.x >= this.minimum.x &&
            point.x <= this.maximum.x &&
            point.y >= this.minimum.y &&
            point.y <= this.maximum.y &&
            point.z >= this.minimum.z &&
            point.z <= this.maximum.z
        );
    }

    public static Intersects(a: BoundingBox, b: BoundingBox): boolean {
        return (
            a.minimum.x <= b.maximum.x &&
            a.maximum.x >= b.minimum.x &&
            a.minimum.y <= b.maximum.y &&
            a.maximum.y >= b.minimum.y &&
            a.minimum.z <= b.maximum.z &&
            a.maximum.z >= b.minimum.z
        );
    }
}

export class BoundingInfo {
    public boundingBox: BoundingBox;
    public boundingSphere: BoundingSphere;

    public constructor(min: Vector3, max: Vector3) {
        this.boundingBox = new BoundingBox(min, max);
        this.boundingSphere = new BoundingSphere(min, max);
    }

    public get minimum(): Vector3 {
        return this.boundingBox.minimum;
    }

    public get maximum(): Vector3 {
        return this.boundingBox.maximum;
    }

    public intersectsPoint(point: Vector3): boolean {
        return this.boundingSphere.intersectsPoint(point) && this.boundingBox.intersectsPoint(point);
    }

    /** World-matrix-aware reframe is not modelled here; reframe by rebuilding from transformed corners. */
    public reConstruct(min: Vector3, max: Vector3, _worldMatrix?: Matrix): void {
        this.boundingBox = new BoundingBox(min, max);
        this.boundingSphere = new BoundingSphere(min, max);
    }
}
