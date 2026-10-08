type Point = [number, number, number];

/** Validated voxel octree in the dataset's coordinate frame. Treat its arrays as read-only. */
export interface SplatVoxelCollision {
    readonly min: Point;
    readonly max: Point;
    readonly resolution: number;
    readonly depth: number;
    readonly nodes: Uint32Array;
    readonly masks: Uint32Array;
}

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const SOLID = 0xff000000;

function invalid(): never {
    throw new Error("Invalid splat voxel collision data.");
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalid();
    }
    return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
        invalid();
    }
    return value;
}

function point(value: unknown): Point {
    if (!Array.isArray(value) || value.length !== 3 || !value.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) {
        invalid();
    }
    return value as Point;
}

function header(value: unknown) {
    const meta = object(value);
    const bounds = object(meta.gridBounds);
    const min = point(bounds.min);
    const max = point(bounds.max);
    const resolution = meta.voxelResolution;
    const depth = integer(meta.treeDepth, 1, 20);
    const nodeCount = integer(meta.nodeCount, 0, 0xffffff);
    const maskCount = integer(meta.leafDataCount, 0, 0x1fffffe);
    if (meta.version !== "1.1" || meta.leafSize !== 4 || typeof resolution !== "number" || !Number.isFinite(resolution) || resolution <= 0 || maskCount % 2 !== 0) {
        invalid();
    }
    for (let axis = 0; axis < 3; axis++) {
        const blocks = (max[axis]! - min[axis]!) / (resolution * 4);
        if (!(blocks > 0) || blocks > 2 ** depth || Math.abs(blocks - Math.round(blocks)) > 1e-5) {
            invalid();
        }
    }
    const bytes = (nodeCount + maskCount) * 4;
    if (bytes > MAX_BINARY_BYTES || (nodeCount === 0 && maskCount !== 0)) {
        invalid();
    }
    return { min, max, resolution, depth, nodeCount, maskCount, bytes };
}

function bits(value: number): number {
    let count = 0;
    for (; value; value &= value - 1) {
        count++;
    }
    return count;
}

/** Validate voxel format 1.1 metadata and copy its little-endian binary into owned storage. */
export function parseSplatVoxelCollision(metadata: unknown, buffer: ArrayBuffer): SplatVoxelCollision {
    const h = header(metadata);
    if (buffer.byteLength !== h.bytes) {
        invalid();
    }
    const words = new Uint32Array(h.nodeCount + h.maskCount);
    const view = new DataView(buffer);
    for (let i = 0; i < words.length; i++) {
        words[i] = view.getUint32(i * 4, true);
    }
    const nodes = words.subarray(0, h.nodeCount);
    const masks = words.subarray(h.nodeCount);
    const levels = new Uint8Array(nodes.length);
    if (nodes.length) {
        levels[0] = 1;
    }
    for (let i = 0; i < nodes.length; i++) {
        const level = levels[i]!;
        const word = nodes[i]!;
        if (!level || level > h.depth + 1) {
            invalid();
        }
        if (word === SOLID) {
            continue;
        }
        const mask = word >>> 24;
        const first = word & 0xffffff;
        if (!mask) {
            if (level !== h.depth + 1 || first * 2 + 1 >= masks.length) {
                invalid();
            }
        } else {
            const end = first + bits(mask);
            if (level > h.depth || first <= i || end > nodes.length) {
                invalid();
            }
            for (let child = first; child < end; child++) {
                if (levels[child]) {
                    invalid();
                }
                levels[child] = level + 1;
            }
        }
    }
    return { min: h.min, max: h.max, resolution: h.resolution, depth: h.depth, nodes, masks };
}

async function readBounded(url: URL, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Collision data: HTTP ${response.status} for ${url.pathname}`);
    }
    if (!response.body || Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        invalid();
    }
    const bytes = new Uint8Array(limit);
    const reader = response.body.getReader();
    let offset = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) {
                break;
            }
            if (offset + part.value.length > limit) {
                invalid();
            }
            bytes.set(part.value, offset);
            offset += part.value.length;
        }
    } catch (reason) {
        await reader.cancel().catch(() => undefined);
        throw reason;
    } finally {
        reader.releaseLock();
    }
    return bytes.subarray(0, offset);
}

/** Load a bounded HTTP(S) .voxel.json/.voxel.bin pair, preserving the URL query on both requests. */
export async function loadSplatVoxelCollision(metadataUrl: string, signal?: AbortSignal): Promise<SplatVoxelCollision> {
    const url = new URL(metadataUrl);
    if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith(".voxel.json")) {
        throw new Error("Collision URL must be an HTTP(S) .voxel.json URL.");
    }
    const metadata: unknown = JSON.parse(new TextDecoder().decode(await readBounded(url, 65536, signal)));
    const h = header(metadata);
    url.pathname = url.pathname.replace(/\.voxel\.json$/, ".voxel.bin");
    const bytes = await readBounded(url, h.bytes, signal);
    if (bytes.byteLength !== h.bytes) {
        invalid();
    }
    return parseSplatVoxelCollision(metadata, bytes.buffer);
}

/** Sweep a box of the given half-extent from a clear starting point, with wall sliding and blocked grid boundaries. */
export function moveSplatVoxelCamera(collision: SplatVoxelCollision, from: Point, to: Point, radius = 0.15): Point {
    if (![...from, ...to, radius].every(Number.isFinite) || radius <= 0) {
        throw new RangeError("Collision motion and radius must be finite; radius must be positive.");
    }
    const position: Point = [...from];
    const delta: Point = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const skin = Math.min(collision.resolution * 0.001, radius * 0.001);
    for (let contact = 0; contact < 3; contact++) {
        let hitTime = 1;
        let hitAxis = -1;
        const intersect = (min: Point, size: number): number => {
            let enter = -Infinity;
            let leave = Infinity;
            let axis = -1;
            for (let a = 0; a < 3; a++) {
                const low = min[a]! - radius;
                const high = min[a]! + size + radius;
                if (delta[a] === 0) {
                    if (position[a]! <= low || position[a]! >= high) {
                        return -1;
                    }
                    continue;
                }
                const t0 = (low - position[a]!) / delta[a]!;
                const t1 = (high - position[a]!) / delta[a]!;
                const near = Math.min(t0, t1);
                if (near > enter) {
                    enter = near;
                    axis = a;
                }
                leave = Math.min(leave, Math.max(t0, t1));
            }
            if (enter > leave || leave <= 0 || enter > hitTime || axis < 0) {
                return -1;
            }
            return axis;
        };
        const visit = (index: number, min: Point, size: number): void => {
            const axis = intersect(min, size);
            if (axis < 0) {
                return;
            }
            const word = collision.nodes[index]!;
            if (word === SOLID) {
                const boundary = min[axis]! + (delta[axis]! > 0 ? -radius : size + radius);
                const time = Math.max(0, (boundary - position[axis]!) / delta[axis]!);
                if (time <= hitTime) {
                    hitTime = time;
                    hitAxis = axis;
                }
                return;
            }
            const mask = word >>> 24;
            if (!mask) {
                for (let bit = 0; bit < 64; bit++) {
                    if (((collision.masks[word * 2 + (bit >>> 5)]! >>> (bit & 31)) & 1) === 0) {
                        continue;
                    }
                    const cell: Point = [min[0] + (bit & 3) * collision.resolution, min[1] + ((bit >>> 2) & 3) * collision.resolution, min[2] + (bit >>> 4) * collision.resolution];
                    const cellAxis = intersect(cell, collision.resolution);
                    if (cellAxis >= 0) {
                        const boundary = cell[cellAxis]! + (delta[cellAxis]! > 0 ? -radius : collision.resolution + radius);
                        const time = Math.max(0, (boundary - position[cellAxis]!) / delta[cellAxis]!);
                        if (time <= hitTime) {
                            hitTime = time;
                            hitAxis = cellAxis;
                        }
                    }
                }
                return;
            }
            let child = word & 0xffffff;
            const half = size / 2;
            for (let octant = 0; octant < 8; octant++) {
                if (mask & (1 << octant)) {
                    visit(child++, [min[0] + (octant & 1) * half, min[1] + ((octant >>> 1) & 1) * half, min[2] + (octant >>> 2) * half], half);
                }
            }
        };
        for (let axis = 0; axis < 3; axis++) {
            if (delta[axis] === 0) {
                continue;
            }
            const boundary = delta[axis]! > 0 ? collision.max[axis]! - radius : collision.min[axis]! + radius;
            const time = Math.max(0, (boundary - position[axis]!) / delta[axis]!);
            if (time <= hitTime) {
                hitTime = time;
                hitAxis = axis;
            }
        }
        if (collision.nodes.length) {
            visit(0, collision.min, collision.resolution * 4 * 2 ** collision.depth);
        }
        const distance = Math.hypot(...delta);
        const travel = hitAxis < 0 ? 1 : Math.max(0, hitTime - skin / Math.max(distance, skin));
        for (let axis = 0; axis < 3; axis++) {
            position[axis] = position[axis]! + delta[axis]! * travel;
            delta[axis] = delta[axis]! * (1 - travel);
        }
        if (hitAxis < 0) {
            break;
        }
        delta[hitAxis] = 0;
    }
    return position;
}
