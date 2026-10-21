import { test, expect } from "../parity/parity-fixtures";
import * as fs from "fs";
import * as path from "path";

/** Mirrors `ExportRoundTrip` in lab/lite/src/export-gltf-test.ts. */
interface ExportRoundTrip {
    first: string;
    second: string;
    third: string;
    warnings: string[];
    counts: { meshes: number; lights: number; reloadedMeshes: number; reloadedLights: number; camera: boolean; reloadedCamera: boolean };
}

/** Local assets covering pass-through hierarchies, negative scale, PBR materials, textures,
 *  animation samplers and cameras. */
const ASSETS = [
    "/gltf-assets/NegativeScaleTest/NegativeScaleTest.glb",
    "/gltf-assets/Node_NegativeScale/Node_NegativeScale_01.gltf",
    "/gltf-assets/MirroredDoubleSided/MirroredDoubleSided.gltf",
    "/gltf-assets/Material/Material_03.gltf",
    "/gltf-assets/Animation_SamplerType/Animation_SamplerType_01.gltf",
    "/gltf-assets/Buffer_Interleaved/Buffer_Interleaved_03.gltf",
    "/gltf-assets/Mesh_PrimitiveMode/Mesh_PrimitiveMode_11.gltf",
    "/models/CarbonFiberWheel.glb",
    "/models/Calculator.glb",
    "/playroom/gltf/chesspiece.glb",
];

const OUT_DIR = path.join(__dirname, "../../../test-results/export-gltf");

function parseGlb(base64: string): { json: Record<string, unknown>; bytes: Buffer } {
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
    const jsonLength = bytes.readUInt32LE(12);
    const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as Record<string, unknown>;
    expect(bytes.readUInt32LE(20 + jsonLength + 4)).toBe(0x004e4942);
    return { json, bytes };
}

function save(name: string, result: ExportRoundTrip): void {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.first.glb`), Buffer.from(result.first, "base64"));
    fs.writeFileSync(path.join(OUT_DIR, `${name}.second.glb`), Buffer.from(result.second, "base64"));
}

test.describe("glTF export round trip", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/lite/export-gltf-test.html");
        await expect(page.locator("#renderCanvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    });

    for (const asset of ASSETS) {
        const name = path.basename(asset).replace(/\.(glb|gltf)$/, "");
        test(`${name}: export → reload → export is a fixed point`, async ({ page }) => {
            const result = await page.evaluate(
                (url) => (window as unknown as { exportGltfTest: { roundTripAsset(u: string): Promise<ExportRoundTrip> } }).exportGltfTest.roundTripAsset(url),
                asset
            );
            save(name, result);
            const first = parseGlb(result.first);
            parseGlb(result.second);
            expect(first.json.asset).toMatchObject({ version: "2.0" });
            // The exported asset reloads into the same scene content.
            expect(result.counts.reloadedMeshes).toBe(result.counts.meshes);
            expect(result.counts.reloadedLights).toBe(result.counts.lights);
            // Idempotence: everything out of scope is dropped by the first export, after which the
            // output is a fixed point.
            expect(result.second).toBe(result.first);
            expect(result.third).toBe(result.second);
        });
    }

    test("native scene: converted geometry, materials, lights and camera reload and re-export identically", async ({ page }) => {
        const result = await page.evaluate(() => (window as unknown as { exportGltfTest: { roundTripNative(): Promise<ExportRoundTrip> } }).exportGltfTest.roundTripNative());
        save("native", result);
        const { json } = parseGlb(result.first);
        parseGlb(result.third);
        expect(result.warnings).toEqual([]);
        expect((json.extensionsUsed as string[]) ?? []).toContain("KHR_lights_punctual");
        expect(json.cameras).toHaveLength(1);
        expect(json.materials).toHaveLength(2);
        // Both materials sample the same checker pixels, so content dedup emits one image.
        expect(json.images).toHaveLength(1);
        expect(result.counts.reloadedMeshes).toBe(result.counts.meshes);
        expect(result.counts.reloadedLights).toBe(result.counts.lights);
        expect(result.counts.reloadedCamera).toBe(true);
        // The first reload quantizes what the loader bakes (1×1 factor textures) and names unnamed
        // cameras; from the second export on, the output is a fixed point.
        expect(result.third).toBe(result.second);
    });
});
