import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile, readFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = process.cwd();
const cache = resolve(root, ".ao-reference-cache", "kitchen");
const usd = await readFile(resolve(cache, "Kitchen.usd"));
const gitBlob = createHash("sha1").update(`blob ${usd.byteLength}\0`).update(usd).digest("hex");
if (gitBlob !== "f0cddb55f5f7b2c246f32978ddde4d0cf797160a") {
    throw new Error("Kitchen source Git blob mismatch.");
}
const require = createRequire(resolve(cache, "gltf-tools", "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { dedup, flatten, join, weld, prune, getBounds } = require("@gltf-transform/functions");
const io = new NodeIO();
const document = await io.read(resolve(cache, "Kitchen.glb"));
const scene = document.getRoot().listScenes()[0];
if (!scene || document.getRoot().listScenes().length !== 1) {
    throw new Error("Kitchen must have exactly one scene.");
}
const count = () =>
    document
        .getRoot()
        .listMeshes()
        .reduce(
            (sum, mesh) =>
                sum +
                mesh.listPrimitives().reduce((n, primitive) => {
                    if (primitive.getMode() !== 4 || !primitive.getIndices()) {
                        throw new Error("Kitchen primitive must contain indexed triangles.");
                    }
                    return n + primitive.getIndices().getCount() / 3;
                }, 0),
            0
        );
const triangles = count();
if (triangles !== 536949) {
    throw new Error(`Kitchen triangulation changed: ${triangles}`);
}
const sourceBounds = getBounds(scene);
function colorSignature() {
    const histogram = new Map();
    const value = [];
    let coloredTriangles = 0;
    for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
            const colors = primitive.getAttribute("COLOR_0");
            if (!colors) {
                continue;
            }
            const indices = primitive.getIndices();
            value.length = 4;
            coloredTriangles += indices.getCount() / 3;
            for (let i = 0; i < indices.getCount(); i++) {
                value[3] = 1;
                colors.getElement(indices.getScalar(i), value);
                const key = value.join(",");
                histogram.set(key, (histogram.get(key) ?? 0) + 1);
            }
        }
    }
    return {
        coloredTriangles,
        indexedColorSha256: createHash("sha256")
            .update(JSON.stringify([...histogram].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
            .digest("hex"),
    };
}
const originalColors = colorSignature();
const scale = document.createNode("USD centimetres to metres").setScale([0.01, 0.01, 0.01]);
for (const child of scene.listChildren()) {
    scene.removeChild(child);
    scale.addChild(child);
}
scene.addChild(scale);
const before = getBounds(scene);
await document.transform(dedup(), flatten(), join({ keepNamed: false }), weld(), prune());
const after = getBounds(scene);
if (count() !== triangles) {
    throw new Error("Kitchen optimization changed triangle count.");
}
if (JSON.stringify(colorSignature()) !== JSON.stringify(originalColors)) {
    throw new Error("Kitchen optimization changed original vertex colors.");
}
for (const side of ["min", "max"]) {
    for (let i = 0; i < 3; i++) {
        if (Math.abs(before[side][i] - after[side][i]) > 0.0001 || Math.abs(sourceBounds[side][i] * 0.01 - after[side][i]) > 0.0001) {
            throw new Error("Kitchen optimization changed world bounds or unit scale.");
        }
    }
}
const destination = resolve(root, "lab", "public", "ssao-comparison");
await mkdir(destination, { recursive: true });
// Without a material, glTF consumers fall back to the default metallic material. Assign the documented
// presentation explicitly: original COLOR_0 on a white, rough, non-metallic base. Added after
// optimization so mesh joining and the geometry checks above are unaffected.
const material = document.createMaterial("Kitchen vertex colors").setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.9);
for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
        primitive.setMaterial(material);
    }
}
const bytes = await io.writeBinary(document);
await writeFile(resolve(destination, "kitchen.glb"), bytes);
await copyFile(resolve(cache, "LICENSE"), resolve(destination, "Kitchen-LICENSE.txt"));
const hash = createHash("sha256").update(bytes).digest("hex");
const manifest = {
    schema: "diligent-kitchen-asset-v1",
    repository: "DiligentGraphics/USDAssets",
    commit: "c823af8961047f4642c985c37338b18a35b6b017",
    source: "Kitchen.usd",
    gitBlob: "f0cddb55f5f7b2c246f32978ddde4d0cf797160a",
    license: "Apache-2.0",
    originalMetresPerUnit: 0.01,
    outputMetresPerUnit: 1,
    sourceMeshes: 1788,
    sourceTriangles: triangles,
    outputMeshes: document.getRoot().listMeshes().length,
    outputTriangles: count(),
    authoredNormals: false,
    materialPresentation: "Original vertex colors on one explicit white, non-metallic glTF material (roughness 0.9); not a Hydrogent material conversion.",
    vertexColors: { preserved: true, ...originalColors },
    originalBounds: sourceBounds,
    boundsMetres: after,
    glbBytes: bytes.byteLength,
    glbSha256: hash,
    conversion: { usd2gltf: "0.3.5", usdCore: "26.11", gltfTransform: "4.3.0" },
};
await writeFile(resolve(destination, "kitchen-source.json"), JSON.stringify(manifest, null, 2) + "\n");
console.info(JSON.stringify(manifest, null, 2));
