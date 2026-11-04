import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ManifestEntry {
    path: string;
    bytes: number;
    sha256: string;
}

interface Manifest {
    sourceRevision: string;
    fileCount: number;
    totalBytes: number;
    files: ManifestEntry[];
}

const root = resolve(process.cwd(), "lab/public/playroom");

describe("The Playroom local asset set", () => {
    it("pins the approved source revision and verifies every declared byte", async () => {
        const manifest = JSON.parse(await readFile(resolve(root, "asset-manifest.json"), "utf8")) as Manifest;
        expect(manifest.sourceRevision).toBe("d22ce23ef308e28d1f8b6598b4c72ea944205925");
        expect(manifest.fileCount).toBe(80);
        let total = 0;
        for (const entry of manifest.files) {
            const path = resolve(root, ...entry.path.split("/"));
            const bytes = await readFile(path);
            expect((await stat(path)).size, entry.path).toBe(entry.bytes);
            expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
            total += entry.bytes;
        }
        expect(total).toBe(manifest.totalBytes);
    });

    it("contains the complete ten-body bunny rig and all local active audio", async () => {
        const rig = JSON.parse(await readFile(resolve(root, "gltf/bunny-rig.json"), "utf8")) as {
            root: string;
            joints: Array<{ name: string; nearestConfiguredParent: string | null }>;
        };
        expect(rig.root).toBe("root");
        expect(rig.joints).toHaveLength(10);
        expect(rig.joints.filter((joint) => joint.nearestConfiguredParent)).toHaveLength(9);
        const sounds = (await stat(resolve(root, "sounds"))).isDirectory();
        expect(sounds).toBe(true);
        await expect((await import("node:fs/promises")).readdir(resolve(root, "sounds"))).resolves.toHaveLength(28);
    });
});
