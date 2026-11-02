export const AO_FIXTURE_IDS = ["plane", "corner", "box-contact", "sphere-contact", "thin-occluder", "screen-edge", "tilted-plane-x", "tilted-plane-y", "depth-step"] as const;
export type AoFixtureId = (typeof AO_FIXTURE_IDS)[number];
type Vec3 = readonly [number, number, number];
type Shape = { kind: "plane"; normal: Vec3; offset: number } | { kind: "box"; center: Vec3; half: Vec3 } | { kind: "sphere"; center: Vec3; radius: number };

export interface AoFixtureSettings {
    width: number;
    height: number;
    near: number;
    far: number;
    tanHalfFovY: number;
    radius: number;
    thickness: number;
    slices: number;
    steps: number;
}
export interface AoFixture {
    id: AoFixtureId;
    settings: AoFixtureSettings;
    depth: Float32Array;
    normals: Float32Array;
    mask: Uint8Array;
    raytraced: Float32Array;
}

export const AO_RAY_COUNT = 256;
export function encodeAoDepth(z: number, near: number, far: number): number {
    return (near * (far / z - 1)) / (far - near);
}
export function decodeAoDepth(depth: number, near: number, far: number): number {
    return (near * far) / (near + depth * (far - near));
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
};

export function intersectAoShape(origin: Vec3, direction: Vec3, shape: Shape, limit: number): { distance: number; normal: Vec3 } | null {
    if (shape.kind === "plane") {
        const denominator = dot(shape.normal, direction);
        if (Math.abs(denominator) < 1e-10) return null;
        const distance = (shape.offset - dot(shape.normal, origin)) / denominator;
        return distance > 1e-6 && distance < limit ? { distance, normal: shape.normal } : null;
    }
    if (shape.kind === "sphere") {
        const delta: Vec3 = [origin[0] - shape.center[0], origin[1] - shape.center[1], origin[2] - shape.center[2]];
        const b = dot(delta, direction);
        const discriminant = b * b - dot(delta, delta) + shape.radius * shape.radius;
        if (discriminant < 0) return null;
        const root = Math.sqrt(discriminant);
        let distance = -b - root;
        if (distance <= 1e-6) distance = -b + root;
        if (distance <= 1e-6 || distance >= limit) return null;
        return { distance, normal: normalize([delta[0] + direction[0] * distance, delta[1] + direction[1] * distance, delta[2] + direction[2] * distance]) };
    }
    let entry = -Infinity;
    let exit = Infinity;
    let axis = 0;
    let side = 1;
    let exitAxis = 0;
    let exitSide = 1;
    for (let i = 0; i < 3; i++) {
        const delta = origin[i]! - shape.center[i]!;
        if (Math.abs(direction[i]!) < 1e-10) {
            if (Math.abs(delta) > shape.half[i]!) return null;
            continue;
        }
        const a = (-shape.half[i]! - delta) / direction[i]!;
        const b = (shape.half[i]! - delta) / direction[i]!;
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        if (low > entry) {
            entry = low;
            axis = i;
            side = direction[i]! > 0 ? -1 : 1;
        }
        if (high < exit) {
            exit = high;
            exitAxis = i;
            exitSide = direction[i]! > 0 ? 1 : -1;
        }
        if (entry > exit) return null;
    }
    const inside = entry <= 1e-6;
    const distance = inside ? exit : entry;
    if (distance <= 1e-6 || distance >= limit) return null;
    const normal: [number, number, number] = [0, 0, 0];
    normal[inside ? exitAxis : axis] = inside ? exitSide : side;
    return { distance, normal };
}

export function aoFixtureGeometry(id: AoFixtureId): readonly Shape[] {
    const back: Shape = { kind: "plane", normal: [0, 0, -1], offset: -5 };
    const floor: Shape = { kind: "plane", normal: [0, 1, 0], offset: -0.75 };
    switch (id) {
        case "plane":
            return [{ kind: "plane", normal: [0, 0, -1], offset: -3 }];
        case "corner":
            return [back, floor, { kind: "plane", normal: [1, 0, 0], offset: -0.8 }];
        case "box-contact":
            return [back, floor, { kind: "box", center: [0, -0.35, 3], half: [0.4, 0.4, 0.4] }];
        case "sphere-contact":
            return [back, floor, { kind: "sphere", center: [0, -0.35, 3], radius: 0.4 }];
        case "thin-occluder":
            return [back, floor, { kind: "box", center: [0, -0.05, 3], half: [0.045, 0.7, 0.045] }];
        case "screen-edge":
            return [floor, { kind: "box", center: [1.95, -0.05, 2.6], half: [0.2, 0.7, 0.2] }];
        case "tilted-plane-x":
            return [{ kind: "plane", normal: [Math.SQRT1_2, 0, -Math.SQRT1_2], offset: -3 * Math.SQRT1_2 }];
        case "tilted-plane-y":
            return [{ kind: "plane", normal: [0, Math.SQRT1_2, -Math.SQRT1_2], offset: -3 * Math.SQRT1_2 }];
        case "depth-step":
            return [back, { kind: "box", center: [1.5, 0, 3], half: [1.5, 3, 0.15] }];
    }
}

function radicalInverse(value: number): number {
    let result = 0;
    let factor = 0.5;
    while (value > 0) {
        result += (value & 1) * factor;
        value >>>= 1;
        factor *= 0.5;
    }
    return result;
}

export function createAoFixture(id: AoFixtureId): AoFixture {
    const settings: AoFixtureSettings = { width: 128, height: 96, near: 0.1, far: 20, tanHalfFovY: Math.tan(Math.PI / 6), radius: 0.6, thickness: 0.25, slices: 3, steps: 3 };
    const { width, height, near, far, radius, tanHalfFovY } = settings;
    const count = width * height;
    const depth = new Float32Array(count);
    const normals = new Float32Array(count * 4);
    const mask = new Uint8Array(count);
    const raytraced = new Float32Array(count).fill(1);
    const shapes = aoFixtureGeometry(id);
    const samples: Vec3[] = [];
    for (let i = 0; i < AO_RAY_COUNT; i++) {
        const u = (i + 0.5) / AO_RAY_COUNT;
        const angle = 2 * Math.PI * radicalInverse(i);
        samples.push([Math.sqrt(u) * Math.cos(angle), Math.sqrt(u) * Math.sin(angle), Math.sqrt(1 - u)]);
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const direction = normalize([((((x + 0.5) / width) * 2 - 1) * tanHalfFovY * width) / height, (1 - ((y + 0.5) / height) * 2) * tanHalfFovY, 1]);
            let hit: { distance: number; normal: Vec3 } | null = null;
            for (const shape of shapes) {
                const candidate = intersectAoShape([0, 0, 0], direction, shape, hit?.distance ?? far / direction[2]);
                if (candidate) hit = candidate;
            }
            if (!hit || hit.distance * direction[2] < near) continue;
            mask[index] = 1;
            const point: Vec3 = [direction[0] * hit.distance, direction[1] * hit.distance, direction[2] * hit.distance];
            depth[index] = encodeAoDepth(point[2], near, far);
            normals.set(hit.normal, index * 4);
            const normal = hit.normal;
            const tangent = normalize(cross(Math.abs(normal[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0], normal));
            const bitangent = cross(normal, tangent);
            const origin: Vec3 = [point[0] + normal[0] * 1e-4, point[1] + normal[1] * 1e-4, point[2] + normal[2] * 1e-4];
            let visible = AO_RAY_COUNT;
            for (const sample of samples) {
                const ray: Vec3 = [
                    tangent[0] * sample[0] + bitangent[0] * sample[1] + normal[0] * sample[2],
                    tangent[1] * sample[0] + bitangent[1] * sample[1] + normal[1] * sample[2],
                    tangent[2] * sample[0] + bitangent[2] * sample[1] + normal[2] * sample[2],
                ];
                if (shapes.some((shape) => intersectAoShape(origin, ray, shape, radius) !== null)) visible--;
            }
            raytraced[index] = visible / AO_RAY_COUNT;
        }
    }
    return { id, settings, depth, normals, mask, raytraced };
}
