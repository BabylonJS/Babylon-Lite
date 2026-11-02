import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SSAO_KITCHEN_URL } from "../../../scripts/fetch-ssao-kitchen.js";

const directory = new URL("../../../lab/public/ssao-comparison/", import.meta.url);
const glb = new URL("kitchen.glb", directory);

describe("Diligent Kitchen asset contract", () => {
    it("pins the Apache-2.0 source, its license and an immutable Assets revision", async () => {
        const manifest = JSON.parse(await readFile(new URL("kitchen-source.json", directory), "utf8"));
        expect(manifest.gitBlob).toBe("f0cddb55f5f7b2c246f32978ddde4d0cf797160a");
        expect(manifest.commit).toBe("c823af8961047f4642c985c37338b18a35b6b017");
        expect(manifest.license).toBe("Apache-2.0");
        expect(SSAO_KITCHEN_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/BabylonJS\/Assets\/[0-9a-f]{40}\/meshes\/DiligentKitchen\/kitchen\.glb$/);
        const license = await readFile(new URL("Kitchen-LICENSE.txt", directory));
        expect(createHash("sha256").update(license).digest("hex")).toBe("c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4");
    });

    // The binary lives in BabylonJS/Assets (`pnpm fetch:ssao-kitchen`, which verifies size and SHA-256).
    it.runIf(existsSync(fileURLToPath(glb)))("preserves every triangle, metre bounds and original vertex colors", async () => {
        const manifest = JSON.parse(await readFile(new URL("kitchen-source.json", directory), "utf8"));
        const bytes = await readFile(glb);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.glbSha256);
        expect(bytes.byteLength).toBe(manifest.glbBytes);
        expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
        expect(bytes.readUInt32LE(4)).toBe(2);
        expect(bytes.readUInt32LE(8)).toBe(bytes.length);
        const json = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12))) as {
            meshes: { primitives: { indices: number; attributes: Record<string, number>; mode: number; material?: number }[] }[];
            materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number } }[];
            accessors: { count: number; bufferView: number; byteOffset?: number; componentType: number; type: string }[];
            bufferViews: { byteOffset?: number; byteStride?: number }[];
        };
        let triangles = 0;
        let coloredTriangles = 0;
        let hasNonGrayColor = false;
        const binary = 20 + bytes.readUInt32LE(12) + 8;
        for (const mesh of json.meshes) {
            for (const primitive of mesh.primitives) {
                expect(primitive.mode ?? 4).toBe(4);
                if (primitive.attributes.COLOR_0 !== undefined) {
                    coloredTriangles += json.accessors[primitive.indices]!.count / 3;
                    const colors = json.accessors[primitive.attributes.COLOR_0]!;
                    expect(colors.componentType).toBe(5126);
                    const offset = binary + (json.bufferViews[colors.bufferView]!.byteOffset ?? 0) + (colors.byteOffset ?? 0);
                    const stride = json.bufferViews[colors.bufferView]!.byteStride ?? (colors.type === "VEC3" ? 12 : 16);
                    for (let i = 0; i < colors.count && !hasNonGrayColor; i++) {
                        const base = offset + i * stride;
                        hasNonGrayColor = bytes.readFloatLE(base) !== bytes.readFloatLE(base + 4) || bytes.readFloatLE(base + 4) !== bytes.readFloatLE(base + 8);
                    }
                }
                expect(primitive.attributes.NORMAL).toBeUndefined();
                expect(primitive.material).toBe(0);
                triangles += json.accessors[primitive.indices]!.count / 3;
            }
        }
        // An explicit material avoids the metallic glTF default for consumers outside Lite.
        expect(json.materials).toHaveLength(1);
        expect(json.materials![0]!.pbrMetallicRoughness).toEqual({ metallicFactor: 0, roughnessFactor: 0.9 });
        expect(triangles).toBe(536949);
        expect(manifest.outputTriangles).toBe(triangles);
        expect(manifest.sourceTriangles).toBe(triangles);
        expect(json.meshes.length).toBe(manifest.outputMeshes);
        expect(coloredTriangles).toBe(535941);
        expect(hasNonGrayColor).toBe(true);
        expect(manifest.vertexColors).toEqual({
            preserved: true,
            coloredTriangles,
            indexedColorSha256: "33be6ce254f41079980396e7c9ff41355979e38427ad55ac729a0484dec5d62c",
        });
        expect(manifest.originalMetresPerUnit).toBe(0.01);
        expect(manifest.outputMetresPerUnit).toBe(1);
        for (const side of ["min", "max"]) {
            for (let c = 0; c < 3; c++) {
                expect(manifest.boundsMetres[side][c]).toBeCloseTo(manifest.originalBounds[side][c] * 0.01, 4);
            }
        }
    });
});
