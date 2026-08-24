import type { PickingInfo as LitePickingInfo } from "babylon-lite";

import type { TransformNode } from "../meshes/meshes.js";
import { Vector3 } from "../math/vector.js";
import type { Vector2 } from "../math/vector.js";
import type { Ray } from "../math/ray.js";

/** Babylon.js-compatible result of a scene pick. */
export class PickingInfo {
    public hit = false;
    public distance = 0;
    public pickedPoint: Vector3 | null = null;
    public pickedMesh: TransformNode | null = null;
    public bu = 0;
    public bv = 0;
    public faceId = -1;
    public subMeshFaceId = -1;
    public subMeshId = 0;
    public pickedSprite: null = null;
    public thinInstanceIndex = -1;
    public ray: Ray | null = null;
    public originMesh: TransformNode | null = null;
    public aimTransform: TransformNode | null = null;
    public gripTransform: TransformNode | null = null;

    private _normal: Vector3 | null = null;
    private _worldNormal: Vector3 | null = null;

    /** @internal Create a compat result from Lite's synchronous CPU-picking result. */
    public static _fromLite(info: LitePickingInfo, pickedMesh: TransformNode | null, ray: Ray): PickingInfo {
        const result = new PickingInfo();
        result.hit = info.hit;
        result.distance = info.distance;
        result.pickedPoint = info.pickedPoint ? Vector3.FromArray(info.pickedPoint) : null;
        result.pickedMesh = pickedMesh;
        result.bu = info.bu;
        result.bv = info.bv;
        result.faceId = info.faceId;
        result.subMeshFaceId = info.faceId;
        result.subMeshId = info.subMeshId;
        result.thinInstanceIndex = info.thinInstanceIndex;
        result.ray = ray;
        result._normal = info.pickedNormal ? Vector3.FromArray(info.pickedNormal) : null;
        result._worldNormal = info.pickedNormalWorld ? Vector3.FromArray(info.pickedNormalWorld) : null;
        return result;
    }

    public getNormal(useWorldCoordinates = false, _useVerticesNormals = true): Vector3 | null {
        return useWorldCoordinates ? (this._worldNormal?.clone() ?? null) : (this._normal?.clone() ?? null);
    }

    public getTextureCoordinates(_uvSet?: string): Vector2 | null {
        return null;
    }
}
