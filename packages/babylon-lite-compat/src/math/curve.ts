/** Babylon.js-compatible curve/path helpers: `Angle`, `Curve3`, `Path3D` (pure JS). */

import { Vector3 } from "./vector.js";
import { Matrix } from "./matrix.js";
import { Quaternion } from "./quaternion.js";
import { Epsilon, Scalar } from "./scalar.js";

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

    /**
     * Babylon.js `Curve3.CreateHermiteSpline` — Hermite spline from `p1` → `p2` with
     * tangents `t1`/`t2`, sampled in `nSeg` segments.
     */
    public static CreateHermiteSpline(p1: Vector3, t1: Vector3, p2: Vector3, t2: Vector3, nSeg: number): Curve3 {
        const hermite: Vector3[] = [];
        const step = 1.0 / nSeg;
        for (let i = 0; i <= nSeg; i++) {
            hermite.push(Vector3.Hermite(p1, t1, p2, t2, i * step));
        }
        return new Curve3(hermite);
    }

    /**
     * Babylon.js `Curve3.CreateCatmullRomSpline` — Catmull-Rom spline through `points`,
     * with `nbPoints` interpolated points between each control point. When `closed`, the
     * spline forms a loop.
     */
    public static CreateCatmullRomSpline(points: Vector3[], nbPoints: number, closed?: boolean): Curve3 {
        const catmullRom: Vector3[] = [];
        const step = 1.0 / nbPoints;
        let amount = 0.0;
        if (closed) {
            const pointsCount = points.length;
            for (let i = 0; i < pointsCount; i++) {
                amount = 0;
                for (let c = 0; c < nbPoints; c++) {
                    catmullRom.push(
                        Vector3.CatmullRom(points[i % pointsCount]!, points[(i + 1) % pointsCount]!, points[(i + 2) % pointsCount]!, points[(i + 3) % pointsCount]!, amount)
                    );
                    amount += step;
                }
            }
            catmullRom.push(catmullRom[0]!);
        } else {
            const totalPoints: Vector3[] = [];
            totalPoints.push(points[0]!.clone());
            totalPoints.push(...points);
            totalPoints.push(points[points.length - 1]!.clone());
            let i = 0;
            for (; i < totalPoints.length - 3; i++) {
                amount = 0;
                for (let c = 0; c < nbPoints; c++) {
                    catmullRom.push(Vector3.CatmullRom(totalPoints[i]!, totalPoints[i + 1]!, totalPoints[i + 2]!, totalPoints[i + 3]!, amount));
                    amount += step;
                }
            }
            i--;
            catmullRom.push(Vector3.CatmullRom(totalPoints[i]!, totalPoints[i + 1]!, totalPoints[i + 2]!, totalPoints[i + 3]!, amount));
        }
        return new Curve3(catmullRom);
    }
}

interface PointAtData {
    id: number;
    point: Vector3;
    previousPointArrayIndex: number;
    position: number;
    subPosition: number;
    interpolateReady: boolean;
    interpolationMatrix: Matrix;
}

/**
 * Babylon.js `Path3D` — a logical 3D path that computes a Frenet-like frame
 * (tangents, normals, binormals) and cumulative distances over its curve points,
 * with interpolated-point queries (`getPointAt` / `getTangentAt` / …).
 */
export class Path3D {
    private readonly _curve: Vector3[] = [];
    private readonly _distances: number[] = [];
    private readonly _tangents: Vector3[] = [];
    private readonly _normals: Vector3[] = [];
    private readonly _binormals: Vector3[] = [];
    private readonly _raw: boolean;
    private readonly _alignTangentsWithPath: boolean;

    private readonly _pointAtData: PointAtData = {
        id: 0,
        point: Vector3.Zero(),
        previousPointArrayIndex: 0,
        position: 0,
        subPosition: 0,
        interpolateReady: false,
        interpolationMatrix: Matrix.Identity(),
    };

    public path: Vector3[];

    public constructor(path: Vector3[], firstNormal: Vector3 | null = null, raw?: boolean, alignTangentsWithPath = false) {
        this.path = path;
        for (let p = 0; p < path.length; p++) {
            this._curve[p] = path[p]!.clone();
        }
        this._raw = raw || false;
        this._alignTangentsWithPath = alignTangentsWithPath;
        this._compute(firstNormal, alignTangentsWithPath);
    }

    public getCurve(): Vector3[] {
        return this._curve;
    }

    public getPoints(): Vector3[] {
        return this._curve;
    }

    public length(): number {
        return this._distances[this._distances.length - 1]!;
    }

    public getTangents(): Vector3[] {
        return this._tangents;
    }

    public getNormals(): Vector3[] {
        return this._normals;
    }

    public getBinormals(): Vector3[] {
        return this._binormals;
    }

    public getDistances(): number[] {
        return this._distances;
    }

    /** Returns an interpolated point along this path, `position` in [0, 1]. */
    public getPointAt(position: number): Vector3 {
        return this._updatePointAtData(position).point;
    }

    public getTangentAt(position: number, interpolated = false): Vector3 {
        this._updatePointAtData(position, interpolated);
        return interpolated ? Vector3.TransformCoordinates(Vector3.Forward(), this._pointAtData.interpolationMatrix) : this._tangents[this._pointAtData.previousPointArrayIndex]!;
    }

    public getNormalAt(position: number, interpolated = false): Vector3 {
        this._updatePointAtData(position, interpolated);
        return interpolated ? Vector3.TransformCoordinates(Vector3.Right(), this._pointAtData.interpolationMatrix) : this._normals[this._pointAtData.previousPointArrayIndex]!;
    }

    public getBinormalAt(position: number, interpolated = false): Vector3 {
        this._updatePointAtData(position, interpolated);
        return interpolated ? Vector3.TransformCoordinates(Vector3.Up(), this._pointAtData.interpolationMatrix) : this._binormals[this._pointAtData.previousPointArrayIndex]!;
    }

    public getDistanceAt(position: number): number {
        return this.length() * position;
    }

    public getPreviousPointIndexAt(position: number): number {
        this._updatePointAtData(position);
        return this._pointAtData.previousPointArrayIndex;
    }

    public getSubPositionAt(position: number): number {
        this._updatePointAtData(position);
        return this._pointAtData.subPosition;
    }

    /** Returns the position (in [0, 1]) of the closest virtual point on this path to `target`. */
    public getClosestPositionTo(target: Vector3): number {
        let smallestDistance = Number.MAX_VALUE;
        let closestPosition = 0.0;
        for (let i = 0; i < this._curve.length - 1; i++) {
            const point = this._curve[i + 0]!;
            const tangent = this._curve[i + 1]!.subtract(point).normalize();
            const subLength = this._distances[i + 1]! - this._distances[i + 0]!;
            const subPosition = Math.min((Math.max(Vector3.Dot(tangent, target.subtract(point).normalize()), 0.0) * Vector3.Distance(point, target)) / subLength, 1.0);
            const distance = Vector3.Distance(point.add(tangent.scale(subPosition * subLength)), target);

            if (distance < smallestDistance) {
                smallestDistance = distance;
                closestPosition = (this._distances[i + 0]! + subLength * subPosition) / this.length();
            }
        }
        return closestPosition;
    }

    /** Returns a sub-path (slice) of this path between `start` and `end` (each in [0, 1]). */
    public slice(start = 0.0, end = 1.0): Path3D {
        if (start < 0.0) {
            start = 1 - ((start * -1.0) % 1.0);
        }
        if (end < 0.0) {
            end = 1 - ((end * -1.0) % 1.0);
        }
        if (start > end) {
            const _start = start;
            start = end;
            end = _start;
        }
        const curvePoints = this.getCurve();

        const startPoint = this.getPointAt(start);
        let startIndex = this.getPreviousPointIndexAt(start);

        const endPoint = this.getPointAt(end);
        const endIndex = this.getPreviousPointIndexAt(end) + 1;

        const slicePoints: Vector3[] = [];
        if (start !== 0.0) {
            startIndex++;
            slicePoints.push(startPoint);
        }

        slicePoints.push(...curvePoints.slice(startIndex, endIndex));
        if (end !== 1.0 || start === 1.0) {
            slicePoints.push(endPoint);
        }
        return new Path3D(slicePoints, this.getNormalAt(start), this._raw, this._alignTangentsWithPath);
    }

    /** Recomputes the path's tangents, normals, binormals and distances from `path`. */
    public update(path: Vector3[], firstNormal: Vector3 | null = null, alignTangentsWithPath = false): Path3D {
        for (let p = 0; p < path.length; p++) {
            this._curve[p]!.x = path[p]!.x;
            this._curve[p]!.y = path[p]!.y;
            this._curve[p]!.z = path[p]!.z;
        }
        this._compute(firstNormal, alignTangentsWithPath);
        return this;
    }

    private _compute(firstNormal: Vector3 | null, alignTangentsWithPath = false): void {
        const l = this._curve.length;

        if (l < 2) {
            return;
        }

        this._tangents[0] = this._getFirstNonNullVector(0);
        if (!this._raw) {
            this._tangents[0].normalize();
        }
        this._tangents[l - 1] = this._curve[l - 1]!.subtract(this._curve[l - 2]!);
        if (!this._raw) {
            this._tangents[l - 1]!.normalize();
        }

        const tg0 = this._tangents[0];
        const pp0 = this._normalVector(tg0, firstNormal);
        this._normals[0] = pp0;
        if (!this._raw) {
            this._normals[0].normalize();
        }
        this._binormals[0] = Vector3.Cross(tg0, this._normals[0]);
        if (!this._raw) {
            this._binormals[0].normalize();
        }
        this._distances[0] = 0.0;

        let prev: Vector3;
        let cur: Vector3;
        let curTang: Vector3;
        let prevNor: Vector3;
        let prevBinor: Vector3;

        for (let i = 1; i < l; i++) {
            prev = this._getLastNonNullVector(i);
            if (i < l - 1) {
                cur = this._getFirstNonNullVector(i);
                this._tangents[i] = alignTangentsWithPath ? cur : prev.add(cur);
                this._tangents[i]!.normalize();
            }
            this._distances[i] = this._distances[i - 1]! + this._curve[i]!.subtract(this._curve[i - 1]!).length();

            curTang = this._tangents[i]!;
            prevBinor = this._binormals[i - 1]!;
            this._normals[i] = Vector3.Cross(prevBinor, curTang);
            if (!this._raw) {
                if (this._normals[i]!.length() === 0) {
                    prevNor = this._normals[i - 1]!;
                    this._normals[i] = prevNor.clone();
                } else {
                    this._normals[i]!.normalize();
                }
            }
            this._binormals[i] = Vector3.Cross(curTang, this._normals[i]!);
            if (!this._raw) {
                this._binormals[i]!.normalize();
            }
        }
        this._pointAtData.id = NaN;
    }

    private _getFirstNonNullVector(index: number): Vector3 {
        let i = 1;
        let nNVector: Vector3 = this._curve[index + i]!.subtract(this._curve[index]!);
        while (nNVector.length() === 0 && index + i + 1 < this._curve.length) {
            i++;
            nNVector = this._curve[index + i]!.subtract(this._curve[index]!);
        }
        return nNVector;
    }

    private _getLastNonNullVector(index: number): Vector3 {
        let i = 1;
        let nLVector: Vector3 = this._curve[index]!.subtract(this._curve[index - i]!);
        while (nLVector.length() === 0 && index > i + 1) {
            i++;
            nLVector = this._curve[index]!.subtract(this._curve[index - i]!);
        }
        return nLVector;
    }

    private _normalVector(vt: Vector3, va: Vector3 | null): Vector3 {
        let normal0: Vector3;
        let tgl = vt.length();
        if (tgl === 0.0) {
            tgl = 1.0;
        }

        if (va === undefined || va === null) {
            let point: Vector3;
            if (!Scalar.WithinEpsilon(Math.abs(vt.y) / tgl, 1.0, Epsilon)) {
                point = new Vector3(0.0, -1.0, 0.0);
            } else if (!Scalar.WithinEpsilon(Math.abs(vt.x) / tgl, 1.0, Epsilon)) {
                point = new Vector3(1.0, 0.0, 0.0);
            } else if (!Scalar.WithinEpsilon(Math.abs(vt.z) / tgl, 1.0, Epsilon)) {
                point = new Vector3(0.0, 0.0, 1.0);
            } else {
                point = Vector3.Zero();
            }
            normal0 = Vector3.Cross(vt, point);
        } else {
            normal0 = Vector3.Cross(vt, va);
            Vector3.CrossToRef(normal0, vt, normal0);
        }
        normal0.normalize();
        return normal0;
    }

    private _updatePointAtData(position: number, interpolateTNB = false): PointAtData {
        if (this._pointAtData.id === position) {
            if (!this._pointAtData.interpolateReady) {
                this._updateInterpolationMatrix();
            }
            return this._pointAtData;
        } else {
            this._pointAtData.id = position;
        }
        const curvePoints = this.getPoints();

        if (position <= 0.0) {
            return this._setPointAtData(0.0, 0.0, curvePoints[0]!, 0, interpolateTNB);
        } else if (position >= 1.0) {
            return this._setPointAtData(1.0, 1.0, curvePoints[curvePoints.length - 1]!, curvePoints.length - 1, interpolateTNB);
        }

        let previousPoint: Vector3 = curvePoints[0]!;
        let currentPoint: Vector3;
        let currentLength = 0.0;
        const targetLength = position * this.length();

        for (let i = 1; i < curvePoints.length; i++) {
            currentPoint = curvePoints[i]!;
            const distance = Vector3.Distance(previousPoint, currentPoint);
            currentLength += distance;
            if (currentLength === targetLength) {
                return this._setPointAtData(position, 1.0, currentPoint, i, interpolateTNB);
            } else if (currentLength > targetLength) {
                const toLength = currentLength - targetLength;
                const diff = toLength / distance;
                const dir = previousPoint.subtract(currentPoint);
                const point = currentPoint.add(dir.scaleInPlace(diff));
                return this._setPointAtData(position, 1 - diff, point, i - 1, interpolateTNB);
            }
            previousPoint = currentPoint;
        }
        return this._pointAtData;
    }

    private _setPointAtData(position: number, subPosition: number, point: Vector3, parentIndex: number, interpolateTNB: boolean): PointAtData {
        this._pointAtData.point = point;
        this._pointAtData.position = position;
        this._pointAtData.subPosition = subPosition;
        this._pointAtData.previousPointArrayIndex = parentIndex;
        this._pointAtData.interpolateReady = interpolateTNB;

        if (interpolateTNB) {
            this._updateInterpolationMatrix();
        }
        return this._pointAtData;
    }

    private _updateInterpolationMatrix(): void {
        this._pointAtData.interpolationMatrix = Matrix.Identity();
        const parentIndex = this._pointAtData.previousPointArrayIndex;

        if (parentIndex !== this._tangents.length - 1) {
            const index = parentIndex + 1;

            const tangentFrom = this._tangents[parentIndex]!.clone();
            const normalFrom = this._normals[parentIndex]!.clone();
            const binormalFrom = this._binormals[parentIndex]!.clone();

            const tangentTo = this._tangents[index]!.clone();
            const normalTo = this._normals[index]!.clone();
            const binormalTo = this._binormals[index]!.clone();

            const quatFrom = Quaternion.RotationQuaternionFromAxis(normalFrom, binormalFrom, tangentFrom);
            const quatTo = Quaternion.RotationQuaternionFromAxis(normalTo, binormalTo, tangentTo);
            const quatAt = Quaternion.Slerp(quatFrom, quatTo, this._pointAtData.subPosition);

            quatAt.toRotationMatrix(this._pointAtData.interpolationMatrix);
        }
    }
}
