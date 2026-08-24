/**
 * Babylon.js-compatible bounding volumes (`BoundingBox`, `BoundingSphere`,
 * `BoundingInfo`) — pure JS over the compat math types.
 *
 * World-space members (`minimumWorld`, `maximumWorld`, `centerWorld`,
 * `extendSizeWorld`, `vectorsWorld`, `radiusWorld`) are derived by transforming
 * the local geometry by the supplied world matrix, exactly as Babylon.js does:
 * all eight corners are transformed and the world AABB is fitted around them, so
 * the result is correct under rotation (transforming only min/max is not).
 */

import { scaleBoundsFromCenterToRef } from "babylon-lite";

import { Vector3 } from "../math/vector.js";
import { Matrix } from "../math/matrix.js";

const boundingSphereScaleMinimum = new Vector3();
const boundingSphereScaleMaximum = new Vector3();

export class BoundingSphere {
    public readonly center = new Vector3();
    public radius: number;
    public readonly centerWorld = new Vector3();
    public radiusWorld: number;
    public readonly minimum = new Vector3();
    public readonly maximum = new Vector3();

    private _worldMatrix: Matrix;

    public constructor(min: Vector3, max: Vector3, worldMatrix?: Matrix) {
        this.radius = 0;
        this.radiusWorld = 0;
        this._worldMatrix = Matrix.Identity();
        this.reConstruct(min, max, worldMatrix);
    }

    public reConstruct(min: Vector3, max: Vector3, worldMatrix?: Matrix): void {
        this.minimum.copyFrom(min);
        this.maximum.copyFrom(max);

        this.center.copyFrom(Vector3.Lerp(min, max, 0.5));
        this.radius = max.subtract(min).length() * 0.5;

        this._update(worldMatrix ?? Matrix.Identity());
    }

    public getWorldMatrix(): Matrix {
        return this._worldMatrix;
    }

    public scale(factor: number): this {
        scaleBoundsFromCenterToRef(this.minimum, this.maximum, this.center, factor, boundingSphereScaleMinimum, boundingSphereScaleMaximum);
        this.reConstruct(boundingSphereScaleMinimum, boundingSphereScaleMaximum, this._worldMatrix);
        return this;
    }

    /** @internal */
    public _update(worldMatrix: Matrix): void {
        Vector3.TransformCoordinatesToRef(this.center, worldMatrix, this.centerWorld);
        // Match Babylon.js `BoundingSphere._update` exactly: transform (1,1,1)
        // as a normal, then use its largest absolute component. Basis-vector
        // lengths would be more conventional geometry, but would break compat.
        const scaled = Vector3.TransformNormal(new Vector3(1, 1, 1), worldMatrix);
        this.radiusWorld = Math.max(Math.abs(scaled.x), Math.abs(scaled.y), Math.abs(scaled.z)) * this.radius;
        this._worldMatrix = worldMatrix;
    }

    public intersectsPoint(point: Vector3): boolean {
        return Vector3.DistanceSquared(this.centerWorld, point) <= this.radiusWorld * this.radiusWorld;
    }

    public static Intersects(a: BoundingSphere, b: BoundingSphere): boolean {
        const r = a.radiusWorld + b.radiusWorld;
        return Vector3.DistanceSquared(a.centerWorld, b.centerWorld) <= r * r;
    }
}

export class BoundingBox {
    public readonly minimum = new Vector3();
    public readonly maximum = new Vector3();
    public readonly center = new Vector3();
    public readonly extendSize = new Vector3();
    /** Center of the AABB in world space. */
    public readonly centerWorld = new Vector3();
    /** Half-size of the AABB in world space (multiply by 2 for the full size). */
    public readonly extendSizeWorld = new Vector3();
    /** Minimum corner of the world-space AABB. */
    public readonly minimumWorld = new Vector3();
    /** Maximum corner of the world-space AABB. */
    public readonly maximumWorld = new Vector3();
    /** The 8 corner points in local space (min/max combinations). */
    public readonly vectors: Vector3[] = [];
    /** The 8 corner points transformed into world space. */
    public readonly vectorsWorld: Vector3[] = [];
    /** The three world-space axis directions of the box (rows of the world matrix). */
    public readonly directions: Vector3[] = [new Vector3(), new Vector3(), new Vector3()];

    private _worldMatrix: Matrix;

    public constructor(min: Vector3, max: Vector3, worldMatrix?: Matrix) {
        for (let i = 0; i < 8; i++) {
            this.vectors.push(new Vector3());
            this.vectorsWorld.push(new Vector3());
        }
        this._worldMatrix = Matrix.Identity();
        this.reConstruct(min, max, worldMatrix);
    }

    public reConstruct(min: Vector3, max: Vector3, worldMatrix?: Matrix): void {
        const minX = min.x,
            minY = min.y,
            minZ = min.z,
            maxX = max.x,
            maxY = max.y,
            maxZ = max.z;

        this.minimum.copyFromFloats(minX, minY, minZ);
        this.maximum.copyFromFloats(maxX, maxY, maxZ);
        this.vectors[0]!.copyFromFloats(minX, minY, minZ);
        this.vectors[1]!.copyFromFloats(maxX, maxY, maxZ);
        this.vectors[2]!.copyFromFloats(maxX, minY, minZ);
        this.vectors[3]!.copyFromFloats(minX, maxY, minZ);
        this.vectors[4]!.copyFromFloats(minX, minY, maxZ);
        this.vectors[5]!.copyFromFloats(maxX, maxY, minZ);
        this.vectors[6]!.copyFromFloats(minX, maxY, maxZ);
        this.vectors[7]!.copyFromFloats(maxX, minY, maxZ);

        this.center.copyFromFloats((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        this.extendSize.copyFromFloats((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);

        this._update(worldMatrix ?? Matrix.Identity());
    }

    public getWorldMatrix(): Matrix {
        return this._worldMatrix;
    }

    /** @internal */
    public _update(world: Matrix): void {
        this.minimumWorld.setAll(Number.MAX_VALUE);
        this.maximumWorld.setAll(-Number.MAX_VALUE);

        for (let i = 0; i < 8; i++) {
            const v = this.vectorsWorld[i]!;
            Vector3.TransformCoordinatesToRef(this.vectors[i]!, world, v);
            this.minimumWorld.minimizeInPlace(v);
            this.maximumWorld.maximizeInPlace(v);
        }

        const minX = this.minimumWorld.x,
            minY = this.minimumWorld.y,
            minZ = this.minimumWorld.z,
            maxX = this.maximumWorld.x,
            maxY = this.maximumWorld.y,
            maxZ = this.maximumWorld.z;
        this.extendSizeWorld.copyFromFloats((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
        this.centerWorld.copyFromFloats((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);

        const m = world.m;
        this.directions[0]!.copyFromFloats(m[0]!, m[1]!, m[2]!);
        this.directions[1]!.copyFromFloats(m[4]!, m[5]!, m[6]!);
        this.directions[2]!.copyFromFloats(m[8]!, m[9]!, m[10]!);

        this._worldMatrix = world;
    }

    public intersectsPoint(point: Vector3): boolean {
        return (
            point.x >= this.minimumWorld.x &&
            point.x <= this.maximumWorld.x &&
            point.y >= this.minimumWorld.y &&
            point.y <= this.maximumWorld.y &&
            point.z >= this.minimumWorld.z &&
            point.z <= this.maximumWorld.z
        );
    }

    public static Intersects(a: BoundingBox, b: BoundingBox): boolean {
        return (
            a.minimumWorld.x <= b.maximumWorld.x &&
            a.maximumWorld.x >= b.minimumWorld.x &&
            a.minimumWorld.y <= b.maximumWorld.y &&
            a.maximumWorld.y >= b.minimumWorld.y &&
            a.minimumWorld.z <= b.maximumWorld.z &&
            a.maximumWorld.z >= b.minimumWorld.z
        );
    }
}

export class BoundingInfo {
    public boundingBox: BoundingBox;
    public boundingSphere: BoundingSphere;

    public constructor(min: Vector3, max: Vector3, worldMatrix?: Matrix) {
        this.boundingBox = new BoundingBox(min, max, worldMatrix);
        this.boundingSphere = new BoundingSphere(min, max, worldMatrix);
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

    /** Babylon.js `BoundingInfo.update` — re-derive the world-space bounds from the
     *  local geometry and a new world matrix. */
    public update(worldMatrix: Matrix): void {
        this.boundingBox._update(worldMatrix);
        this.boundingSphere._update(worldMatrix);
    }

    /** Rebuild the local bounds and (optionally) re-derive world-space bounds from
     *  the supplied world matrix, transforming all eight corners. */
    public reConstruct(min: Vector3, max: Vector3, worldMatrix?: Matrix): void {
        this.boundingBox.reConstruct(min, max, worldMatrix);
        this.boundingSphere.reConstruct(min, max, worldMatrix);
    }
}
