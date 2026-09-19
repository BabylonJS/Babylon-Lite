export interface ComparisonBound {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
}

function normalize(value: readonly [number, number, number]): [number, number, number] {
    const length = Math.hypot(value[0], value[1], value[2]);
    if (!Number.isFinite(length) || length === 0) {
        throw new RangeError("LOD comparison camera basis is invalid");
    }
    return [value[0] / length, value[1] / length, value[2] / length];
}

function cross(left: readonly [number, number, number], right: readonly [number, number, number]): [number, number, number] {
    return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function addScaled(left: readonly [number, number, number], right: readonly [number, number, number], scale: number): [number, number, number] {
    return [left[0] + right[0] * scale, left[1] + right[1] * scale, left[2] + right[2] * scale];
}

function planeIntersects(bound: ComparisonBound, normal: readonly [number, number, number], offset: number): boolean {
    const x = normal[0] >= 0 ? bound.max[0] : bound.min[0];
    const y = normal[1] >= 0 ? bound.max[1] : bound.min[1];
    const z = normal[2] >= 0 ? bound.max[2] : bound.min[2];
    return normal[0] * x + normal[1] * y + normal[2] * z + offset >= 0;
}

/** Applies the stream's source Z reflection followed by the Trogir scene's 180-degree Z rotation. */
export function transformTrogirManifestBound(raw: { readonly min: readonly number[]; readonly max: readonly number[] }): ComparisonBound {
    return {
        min: [-raw.max[0]!, -raw.max[1]!, -raw.max[2]!],
        max: [-raw.min[0]!, -raw.min[1]!, -raw.min[2]!],
    };
}

/** Shared conservative AABB mask in Lite's left-handed world coordinates. */
export function intersectsComparisonFrustum(
    bound: ComparisonBound,
    eye: readonly [number, number, number],
    target: readonly [number, number, number],
    verticalFov: number,
    aspect: number,
    near: number,
    far: number
): boolean {
    const forward = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = normalize(cross([0, 1, 0], forward));
    const up = normalize(cross(forward, right));
    const tanVertical = Math.tan(verticalFov * 0.5);
    const tanHorizontal = tanVertical * aspect;
    const planes: [readonly [number, number, number], number][] = [
        [forward, -forward[0] * (eye[0] + forward[0] * near) - forward[1] * (eye[1] + forward[1] * near) - forward[2] * (eye[2] + forward[2] * near)],
        [[-forward[0], -forward[1], -forward[2]], forward[0] * (eye[0] + forward[0] * far) + forward[1] * (eye[1] + forward[1] * far) + forward[2] * (eye[2] + forward[2] * far)],
        [normalize(addScaled(right, forward, tanHorizontal)), 0],
        [normalize(addScaled([-right[0], -right[1], -right[2]], forward, tanHorizontal)), 0],
        [normalize(addScaled(up, forward, tanVertical)), 0],
        [normalize(addScaled([-up[0], -up[1], -up[2]], forward, tanVertical)), 0],
    ];
    for (let index = 2; index < planes.length; index++) {
        const plane = planes[index]!;
        planes[index] = [plane[0], -(plane[0][0] * eye[0] + plane[0][1] * eye[1] + plane[0][2] * eye[2])];
    }
    return planes.every(([normal, offset]) => planeIntersects(bound, normal, offset));
}

export function distanceToComparisonBound(eye: readonly [number, number, number], bound: ComparisonBound): number {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
        const delta = eye[axis]! < bound.min[axis]! ? bound.min[axis]! - eye[axis]! : eye[axis]! > bound.max[axis]! ? eye[axis]! - bound.max[axis]! : 0;
        squared += delta * delta;
    }
    return Math.sqrt(squared);
}
