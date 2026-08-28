/**
 * Parity tests for the Antigravity Racer engine trail.
 *
 * The trail is the port of node material 23KY8X#14 plus its 1×256 RGBA-float
 * `RawTexture` history. Because that texture is a `RawTexture` (CLAMP on both
 * axes), the original ground's rows 0 and 256 read the same texel twice and
 * collapse to NaN, so only rows 1…255 ever draw — which is exactly the strip
 * built here. See `docs/lite/architecture/demo-antigravity-racer.md`.
 *
 * The demo's `babylon-lite` imports resolve to the REAL package source, so the
 * ShaderMaterial and StorageBuffer under test are the real ones; only the GPU
 * device is stubbed.
 */

import { describe, expect, it } from "vitest";

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

interface StorageBufferLike {
    _data: Uint8Array | null;
    byteLength: number;
}

interface ShaderMaterialLike {
    name?: string;
    vertexSource: string;
    fragmentSource: string;
    attributes: readonly string[];
    uniformDecls: readonly { name: string }[];
    storageBufferDecls: readonly { name: string }[];
    needAlphaBlending: boolean;
    blendMode: string;
    depthWrite: boolean;
    backFaceCulling: boolean;
    _storageBufferSlots: Map<string, { current: StorageBufferLike | null }>;
}

interface MeshLike {
    name: string;
    material: ShaderMaterialLike;
    boundMin: [number, number, number];
    boundMax: [number, number, number];
    _cpuIndices?: Uint32Array;
    _cpuUvs?: Float32Array;
    _cpuPositions?: Float32Array;
}

interface ShipTrail {
    mesh: MeshLike;
    material: ShaderMaterialLike;
    push(pos: Vec3, intensity: number): void;
    dispose(): void;
}

const trailPath = "../../../lab/lite/src/demos/antigravity-racer/trail.js";
const { buildTrailStrip, createShipTrail, TRAIL_HISTORY, TRAIL_ROWS } = (await import(trailPath)) as {
    buildTrailStrip: () => { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array };
    createShipTrail: (engine: unknown, startPos: Vec3) => ShipTrail;
    TRAIL_HISTORY: number;
    TRAIL_ROWS: number;
};

/** Device stand-in: `createStorageBuffer` maps a buffer, `updateStorageBuffer` writes through the queue. */
function stubEngine(): unknown {
    return {
        _device: {
            createBuffer: (desc: { size: number }) => ({
                getMappedRange: () => new ArrayBuffer(desc.size),
                unmap: () => {},
                destroy: () => {},
            }),
            queue: { writeBuffer: () => {} },
        },
    };
}

/** The live history mirror the demo keeps inside its storage buffer. */
function historyOf(trail: ShipTrail): Float32Array {
    const buffer = trail.material._storageBufferSlots.get("trailHistory")!.current!;
    const bytes = buffer._data!;
    return new Float32Array(bytes.buffer, bytes.byteOffset, TRAIL_HISTORY * 4);
}

describe("trail strip geometry", () => {
    it("builds the original's non-degenerate rows only: 510 vertices, 254 quads, 1524 indices", () => {
        const { positions, normals, uvs, indices } = buildTrailStrip();
        expect(TRAIL_HISTORY).toBe(256);
        expect(TRAIL_ROWS).toBe(255);
        expect(positions.length / 3).toBe(510);
        expect(normals.length / 3).toBe(510);
        expect(uvs.length / 2).toBe(510);
        expect(indices.length).toBe(1524);
        expect(indices.length / 6).toBe(254);
    });

    it("maps row j to the original ground's v = (255 - j) / 256, newest at v = 255/256", () => {
        const { uvs } = buildTrailStrip();
        expect(uvs[0]).toBe(0);
        expect(uvs[1]).toBeCloseTo(255 / 256, 12);
        expect(uvs[2]).toBe(1);
        expect(uvs[3]).toBeCloseTo(255 / 256, 12);
        const lastRow = (TRAIL_ROWS - 1) * 2;
        expect(uvs[lastRow * 2 + 1]).toBeCloseTo(1 / 256, 12);
        // Strictly decreasing v: row 0 is the newest sample, the last row the oldest.
        for (let j = 1; j < TRAIL_ROWS; j++) {
            expect(uvs[j * 2 * 2 + 1]!).toBeLessThan(uvs[(j - 1) * 2 * 2 + 1]!);
        }
    });

    it("emits CreateGround's index pattern so the winding (and back-face culling) matches", () => {
        const { indices } = buildTrailStrip();
        // Quad j uses a = 2j, b = a+1, c = a+2, d = a+3 as (d, b, a) + (c, d, a).
        expect(Array.from(indices.slice(0, 6))).toEqual([3, 1, 0, 2, 3, 0]);
        expect(Array.from(indices.slice(6, 12))).toEqual([5, 3, 2, 4, 5, 2]);
    });

    it("leaves positions at the origin — the vertex shader places every vertex", () => {
        const { positions } = buildTrailStrip();
        expect(positions.every((v) => v === 0)).toBe(true);
    });
});

describe("trail material", () => {
    const trail = createShipTrail(stubEngine(), { x: 1, y: 2, z: 3 });
    const material = trail.material;

    it("alpha-blends without writing depth and culls back faces like the original", () => {
        expect(material.needAlphaBlending).toBe(true);
        expect(material.blendMode).toBe("alpha");
        expect(material.depthWrite).toBe(false);
        expect(material.backFaceCulling).toBe(true);
    });

    it("binds only the per-ship history buffer plus the two system uniforms it needs", () => {
        expect(material.storageBufferDecls.map((b) => b.name)).toEqual(["trailHistory"]);
        expect(material.uniformDecls.map((u) => u.name)).toEqual(["viewProjection", "cameraPosition"]);
        expect(material.attributes).toEqual(["position", "uv"]);
    });

    it("reproduces the node graph's vertex stage statement for statement", () => {
        const vs = material.vertexSource;
        expect(vs).toContain("let t = clamp(v * 256.0 - 0.5, 0.0, 255.0);");
        expect(vs).toContain("let i1 = min(i0 + 1u, 255u);");
        expect(vs).toContain("let sx = (input.uv.x - 0.5) * 2.0;");
        expect(vs).toContain("let s1 = sampleHistory(v + 0.001);");
        expect(vs).toContain("let tangent = normalize(s0.xyz - s1.xyz);");
        expect(vs).toContain("let view = normalize(s0.xyz - shaderSystem.cameraPosition);");
        expect(vs).toContain("let right = normalize(cross(view, tangent));");
        expect(vs).toContain("let world = s0.xyz + right * (sx * 0.1);");
    });

    it("reproduces the node graph's constant cyan and its alpha curve", () => {
        const fs = material.fragmentSource;
        expect(fs).toContain("let alpha = max(0.0, sin(input.sx * 3.14) * sin(input.vv * 1.57) * input.intensity);");
        expect(fs).toContain("return vec4<f32>(1.0 / 255.0, 213.0 / 255.0, 253.0 / 255.0, alpha);");
    });

    it("publishes the playground's explicit huge bounding box", () => {
        expect(trail.mesh.boundMin).toEqual([-1000, -1000, -1000]);
        expect(trail.mesh.boundMax).toEqual([1000, 1000, 1000]);
    });
});

describe("trail history", () => {
    it("seeds every sample at the spawn position with zero intensity", () => {
        const trail = createShipTrail(stubEngine(), { x: 1, y: 2, z: 3 });
        const history = historyOf(trail);
        for (let i = 0; i < TRAIL_HISTORY; i++) {
            expect([history[i * 4], history[i * 4 + 1], history[i * 4 + 2], history[i * 4 + 3]]).toEqual([1, 2, 3, 0]);
        }
        trail.dispose();
    });

    it("appends newest-last and shifts the oldest out, one upload per push", () => {
        const trail = createShipTrail(stubEngine(), { x: 0, y: 0, z: 0 });
        for (let i = 1; i <= 3; i++) {
            trail.push({ x: i, y: i * 2, z: i * 3 }, i / 10);
        }
        const history = historyOf(trail);
        const last = TRAIL_HISTORY - 1;
        expect(Array.from(history.slice(last * 4, last * 4 + 4))).toEqual([3, 6, 9, 0.30000001192092896]);
        expect(Array.from(history.slice((last - 1) * 4, (last - 1) * 4 + 4))).toEqual([2, 4, 6, 0.20000000298023224]);
        expect(Array.from(history.slice((last - 2) * 4, (last - 2) * 4 + 4))).toEqual([1, 2, 3, 0.10000000149011612]);
        // Everything older is still the seeded spawn sample.
        expect(Array.from(history.slice(0, 4))).toEqual([0, 0, 0, 0]);
        trail.dispose();
    });

    it("rolls the whole window after 256 pushes", () => {
        const trail = createShipTrail(stubEngine(), { x: 0, y: 0, z: 0 });
        for (let i = 0; i < TRAIL_HISTORY; i++) {
            trail.push({ x: i, y: 0, z: 0 }, 1);
        }
        const history = historyOf(trail);
        expect(history[0]).toBe(0);
        expect(history[(TRAIL_HISTORY - 1) * 4]).toBe(TRAIL_HISTORY - 1);
        trail.dispose();
    });

    it("stops writing after dispose", () => {
        const trail = createShipTrail(stubEngine(), { x: 0, y: 0, z: 0 });
        trail.dispose();
        expect(() => trail.push({ x: 9, y: 9, z: 9 }, 1)).not.toThrow();
        trail.dispose();
    });
});
