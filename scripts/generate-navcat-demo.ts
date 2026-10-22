/** Regenerate the original offline-baked Navcat demo asset; never imported by the demo. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateNavcatMesh } from "../packages/babylon-lite/src/navigation/navcat-generation.js";

async function main(): Promise<void> {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let z = -4; z < 4; z++) {
        for (let x = -6; x < 6; x++) {
            if (x >= -1 && x < 1 && z >= -2 && z < 2) {
                continue;
            }
            const offset = positions.length / 3;
            positions.push(x, 0, z, x + 1, 0, z, x + 1, 0, z + 1, x, 0, z + 1);
            indices.push(offset, offset + 2, offset + 1, offset, offset + 3, offset + 2);
        }
    }
    const json = await generateNavcatMesh({ positions: new Float64Array(positions), indices: new Uint32Array(indices) });
    // Author an optional higher-cost region in the lower passage; endpoints remain unrestricted.
    const mesh = JSON.parse(json) as {
        nodes: { type: number; tileId: number; polyIndex: number; area: number }[];
        tiles: Record<number, { vertices: number[]; polys: { vertices: number[]; area: number }[] }>;
    };
    for (const node of mesh.nodes) {
        if (node.type !== 0) {
            continue;
        }
        const tile = mesh.tiles[node.tileId]!;
        const poly = tile.polys[node.polyIndex]!;
        const x = poly.vertices.reduce((sum, index) => sum + tile.vertices[index * 3]!, 0) / poly.vertices.length;
        const z = poly.vertices.reduce((sum, index) => sum + tile.vertices[index * 3 + 2]!, 0) / poly.vertices.length;
        node.area = poly.area = Math.abs(x) < 1.8 && z > 2 ? 2 : 0;
    }
    writeFileSync(resolve(__dirname, "../lab/public/navcat/demo-navmesh.json"), JSON.stringify(mesh) + "\n");
}
void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
