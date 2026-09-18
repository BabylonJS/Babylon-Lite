import { describe, expect, it } from "vitest";

import { parseLooseSogV2Metadata, parseSplatStreamManifest, validateLooseSogV2Images } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-meta";
import { normalizeSplatStreamOptions } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types";

const META_URL = "https://assets.example/scene/lod-meta.json";

function bound(min = [0, 0, -1], max = [1, 1, 0]): { min: number[]; max: number[] } {
    return { min, max };
}

function manifest(tree: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: 1,
        lodLevels: 4,
        filenames: ["coarse/meta.json", "fine/meta.json"],
        tree,
        ...extra,
    };
}

function leaf(lods: Record<string, unknown>, errors?: unknown): Record<string, unknown> {
    return { bound: bound(), lods, ...(errors === undefined ? {} : { errors }) };
}

function rep(file: number, offset: number, count: number): Record<string, number> {
    return { file, offset, count };
}

function sog(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const codebook = Array.from({ length: 256 }, (_, index) => index / 10);
    return {
        version: 2,
        count: 10,
        means: { mins: [-1, -2, -3], maxs: [1, 2, 3], files: ["means-l.webp", "means-h.webp"] },
        scales: { codebook, files: ["scales.webp"] },
        quats: { files: ["quats.webp"] },
        sh0: { codebook, files: ["sh0.webp"] },
        ...extra,
    };
}

describe("lod-meta v1", () => {
    it("parses sparse LODs, derives errors, converts handedness, and aggregates duplicate URLs", () => {
        const input = manifest(
            {
                bound: bound([-2, -1, -5], [4, 3, 2]),
                children: [leaf({ "0": rep(0, 0, 25), "1": rep(0, 25, 0), "2": rep(1, 0, 100) }), leaf({ "0": rep(0, 25, 20), "2": rep(1, 100, 80) })],
            },
            { filenames: ["shared/meta.json", "./shared/meta.json"] }
        );
        const parsed = parseSplatStreamManifest(input, META_URL);

        expect(parsed.sources).toHaveLength(1);
        expect(parsed.sources[0]!.consumers).toHaveLength(4);
        expect(parsed.leaves.map((item) => item.id)).toEqual([0, 1]);
        expect(Array.from(parsed.root.boundMin)).toEqual([-2, -1, -2]);
        expect(Array.from(parsed.root.boundMax)).toEqual([4, 3, 5]);
        expect(parsed.leaves[0]!.alternatives.map((item) => item.lod)).toEqual([0, 2]);
        expect(parsed.leaves[0]!.alternatives[0]!.error).toBeCloseTo(Math.log(4));
        expect(parsed.leaves[0]!.alternatives[1]!.error).toBe(0);
    });

    it("accepts and validates splat-transform manifest summary metadata", () => {
        const parsed = parseSplatStreamManifest(
            manifest(leaf({ "0": rep(0, 0, 1) }), {
                asset: { generator: "splat-transform v3.3.3", chunkGaussians: 524288, chunkExtent: 16 },
                count: 1,
                counts: [1, 1, 1, 1],
            }),
            META_URL
        );
        expect(parsed.leaves).toHaveLength(1);
        expect(() => parseSplatStreamManifest(manifest(leaf({ "0": rep(0, 0, 1) }), { counts: [1] }), META_URL)).toThrow("exactly 4");
    });

    it("builds a Pareto chain without assuming authored LOD/count monotonicity", () => {
        const parsed = parseSplatStreamManifest(
            manifest(leaf({ "0": rep(0, 0, 10), "1": rep(0, 10, 20), "2": rep(1, 0, 30), "3": rep(1, 30, 40) }, [5, 5, 3, 4]), {
                lodErrors: true,
            }),
            META_URL
        );

        expect(parsed.leaves[0]!.alternatives.map(({ lod, count, error }) => ({ lod, count, error }))).toEqual([
            { lod: 0, count: 10, error: 5 },
            { lod: 2, count: 30, error: 3 },
        ]);
    });

    it("ignores absent and zero-count levels when reading authored errors", () => {
        const parsed = parseSplatStreamManifest(
            manifest(leaf({ "0": rep(0, 0, 5), "2": rep(1, 0, 0), "3": rep(1, 0, 20) }, [4, Number.NaN, Number.NaN, 0]), { lodErrors: true }),
            META_URL
        );
        expect(parsed.leaves[0]!.alternatives.map((item) => item.lod)).toEqual([0, 3]);
    });

    it("rejects unsupported versions, unsafe files, malformed ranges, bounds, and node shapes", () => {
        expect(() => parseSplatStreamManifest({ ...manifest(leaf({ "0": rep(0, 0, 1) })), version: 2 }, META_URL)).toThrow("version 1");
        expect(() => parseSplatStreamManifest({ ...manifest(leaf({ "0": rep(0, 0, 1) })), filenames: ["../secret/meta.json"] }, META_URL)).toThrow("traversal");
        expect(() => parseSplatStreamManifest({ ...manifest(leaf({ "0": rep(0, 0, 1) })), filenames: ["%2e%2e%5csecret/meta.json"] }, META_URL)).toThrow("traversal");
        expect(() => parseSplatStreamManifest({ ...manifest(leaf({ "0": rep(0, 0, 1) })), filenames: ["packed.sog"] }, META_URL)).toThrow("packed .sog");
        expect(() => parseSplatStreamManifest(manifest(leaf({ "0": rep(2, 0, 1) })), META_URL)).toThrow("outside filenames");
        expect(() => parseSplatStreamManifest(manifest(leaf({ "0": rep(0, Number.MAX_SAFE_INTEGER, 1) })), META_URL)).toThrow("offset + count");
        expect(() => parseSplatStreamManifest(manifest({ bound: bound([1, 0, 0], [0, 1, 1]), lods: { "0": rep(0, 0, 1) } }), META_URL)).toThrow("min exceeds max");
        expect(() => parseSplatStreamManifest(manifest({ bound: bound(), children: [], lods: {} }), META_URL)).toThrow("exactly one");
        expect(() => parseSplatStreamManifest(manifest({ bound: bound(), children: [], extra: true }), META_URL)).toThrow("unsupported property");
    });

    it("detects reused objects and excessive tree depth", () => {
        const shared = leaf({ "0": rep(0, 0, 1) });
        expect(() => parseSplatStreamManifest(manifest({ bound: bound(), children: [shared, shared] }), META_URL)).toThrow("cycle or reused");

        let tree: Record<string, unknown> = leaf({ "0": rep(0, 0, 1) });
        for (let index = 0; index < 65; index++) {
            tree = { bound: bound(), children: [tree] };
        }
        expect(() => parseSplatStreamManifest(manifest(tree), META_URL)).toThrow("depth exceeds");
    });

    it("validates option defaults and ranges before allocation", () => {
        expect(normalizeSplatStreamOptions()).toMatchObject({
            maxSplats: 1_000_000,
            maxCapacitySplats: 1_000_000,
            maxGpuBytes: 256 * 1024 * 1024,
            maxCpuBytes: 64 * 1024 * 1024,
            maxConcurrentRequests: 6,
            maxConcurrentDecodes: 2,
            screenError: 2,
            lodHysteresis: 0.15,
            maxRetries: 2,
        });
        expect(() => normalizeSplatStreamOptions({ maxConcurrentRequests: 33 })).toThrow(RangeError);
        expect(normalizeSplatStreamOptions({ maxSplats: 750_000, maxCapacitySplats: 4_010_000 })).toMatchObject({
            maxSplats: 750_000,
            maxCapacitySplats: 4_010_000,
        });
        expect(() => normalizeSplatStreamOptions({ maxSplats: 750_000, maxCapacitySplats: 749_999 })).toThrow("at least maxSplats");
        expect(() => normalizeSplatStreamOptions({ maxConcurrentDecodes: 0 })).toThrow(RangeError);
        expect(() => normalizeSplatStreamOptions({ lodHysteresis: 1.1 })).toThrow(RangeError);
        expect(() => normalizeSplatStreamOptions({ maxRetries: -1 })).toThrow(RangeError);
    });
});

describe("loose SOG v2 metadata", () => {
    it("accepts validated generator metadata", () => {
        const parsed = parseLooseSogV2Metadata(sog({ asset: { generator: "splat-transform v3.3.3" } }), "https://assets.example/chunk/meta.json");
        expect(parsed.count).toBe(10);
        expect(() => parseLooseSogV2Metadata(sog({ asset: { generator: "" } }), "https://assets.example/chunk/meta.json")).toThrow("nonempty string");
    });

    it("accepts exactly the DC/SH0 five-image subset and resolves its URLs", () => {
        const parsed = parseLooseSogV2Metadata(sog(), "https://assets.example/chunk/meta.json");
        expect(parsed.count).toBe(10);
        expect(parsed.scaleCodebook).toHaveLength(256);
        expect(parsed.sh0Codebook[255]).toBeCloseTo(25.5);
        expect(parsed.imageUrls).toEqual([
            "https://assets.example/chunk/means-l.webp",
            "https://assets.example/chunk/means-h.webp",
            "https://assets.example/chunk/scales.webp",
            "https://assets.example/chunk/quats.webp",
            "https://assets.example/chunk/sh0.webp",
        ]);
    });

    it("rejects SOG v1, SHN, packed inputs, malformed bounds, and codebooks", () => {
        expect(() => parseLooseSogV2Metadata(sog({ version: 1 }), META_URL)).toThrow("version 2");
        expect(() => parseLooseSogV2Metadata(sog({ shN: {} }), META_URL)).toThrow("higher-order SH");
        const packed = sog();
        (packed.means as { files: string[] }).files[0] = "means.sog";
        expect(() => parseLooseSogV2Metadata(packed, META_URL)).toThrow("packed .sog");
        const unordered = sog();
        (unordered.means as { mins: number[] }).mins[0] = 2;
        expect(() => parseLooseSogV2Metadata(unordered, META_URL)).toThrow("mins exceeds maxs");
        const short = sog();
        (short.scales as { codebook: number[] }).codebook.pop();
        expect(() => parseLooseSogV2Metadata(short, META_URL)).toThrow("256");
    });

    it("validates image dimensions, WebP format, padding, CPU admission, and intervals", () => {
        const parsed = parseLooseSogV2Metadata(sog(), META_URL);
        const images = Array.from({ length: 5 }, () => ({ width: 4, height: 3, mimeType: "image/webp" }));
        expect(validateLooseSogV2Images(parsed, images, 240, [{ offset: 2, count: 8 }])).toBe(240);
        expect(() => validateLooseSogV2Images(parsed, images, 239, [])).toThrow("maxCpuBytes");
        expect(() => validateLooseSogV2Images(parsed, images, 240, [{ offset: 3, count: 8 }])).toThrow("exceeds SOG");
        expect(() =>
            validateLooseSogV2Images(
                parsed,
                images.map((image, index) => (index === 4 ? { width: 5, height: 3, mimeType: "image/webp" } : image)),
                300,
                []
            )
        ).toThrow("identical");
        expect(() =>
            validateLooseSogV2Images(
                parsed,
                images.map((image, index) => (index === 0 ? { width: 4, height: 3, mimeType: "image/png" } : image)),
                240,
                []
            )
        ).toThrow("image/webp");

        const oversized = parseLooseSogV2Metadata(sog({ count: 1 }), META_URL);
        const largeImages = Array.from({ length: 5 }, () => ({ width: 100, height: 100, url: "https://assets.example/data.webp" }));
        expect(() => validateLooseSogV2Images(oversized, largeImages, 200_000, [])).toThrow("padding");
    });
});
