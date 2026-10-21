/** Ports of the Babylon.js glTF serializer unit tests that start from a hand-built glTF document:
 *  the document is loaded by Lite's real loader (which needs WebGPU), exported once, and the
 *  exported GLB is checked. The native-scene ports live in
 *  tests/lite/unit/export-gltf/bjs-ports.test.ts. */

import { test, expect } from "../parity/parity-fixtures";
import type { Page } from "@playwright/test";
import { createTriangleFixture, parseGlb, readAccessor } from "./export-gltf-helpers";
import type { GltfFixture, GltfJson, ParsedGlb } from "./export-gltf-helpers";

/** Mirrors `ExportGltfTest.exportGlb` in lab/lite/src/export-gltf-test.ts. */
interface ExportGlbResult {
    glb: string;
    warnings: string[];
}

/** Load a fixture into a fresh scene through the page, export it once and parse the result. */
async function roundTrip(page: Page, fixture: GltfFixture): Promise<ParsedGlb & { warnings: string[] }> {
    const result = await page.evaluate(
        (glb) => (window as unknown as { exportGltfTest: { exportGlb(g: string): Promise<ExportGlbResult> } }).exportGltfTest.exportGlb(glb),
        fixture.toGlb().toString("base64")
    );
    return { ...parseGlb(result.glb), warnings: result.warnings };
}

function expectValuesClose(actual: number[], expected: number[], digits = 5): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits));
}

test.beforeEach(async ({ page }) => {
    await page.goto("/lite/export-gltf-test.html");
    await expect(page.locator("#renderCanvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
});

test.describe("Babylon.js glTFExporter.test.ts", () => {
    test("preserves node hierarchy, names and transforms of an imported asset", async ({ page }) => {
        const source = createTriangleFixture();
        source.json.nodes = [
            { name: "parent", translation: [1, 2, 3], rotation: [0, 0.38268343, 0, 0.92387953], scale: [2, 2, 2], children: [1, 2] },
            { name: "child", mesh: 0, translation: [0, 1, 0] },
            { name: "empty", scale: [1, 3, 1] },
        ];

        const { json } = await roundTrip(page, source);

        const nodes: GltfJson[] = json.nodes;
        const parent = nodes.find((n) => n.name === "parent");
        const child = nodes.find((n) => n.name === "child");
        const empty = nodes.find((n) => n.name === "empty");
        if (!parent || !child || !empty || !parent.children) {
            throw new Error("Expected the exported node hierarchy");
        }
        expect(json.scenes[0].nodes).toEqual([nodes.indexOf(parent)]);
        expect(parent.children.map((i: number) => nodes[i]!.name).sort()).toEqual(["child", "empty"]);
        expect(parent.translation).toEqual([1, 2, 3]);
        expect(parent.scale).toEqual([2, 2, 2]);
        expect(parent.rotation[1]).toBeCloseTo(0.38268343);
        expect(parent.rotation[3]).toBeCloseTo(0.92387953);
        expect(child.translation).toEqual([0, 1, 0]);
        expect(empty.scale).toEqual([1, 3, 1]);
        expect(child.mesh).toBe(0);
    });

    test("round trips vertex data and mode of a primitive", async ({ page }) => {
        const source = createTriangleFixture();
        const sourceUvs = new Float32Array([0, 0, 1, 0, 0, 1]);
        const sourceColors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
        const uvAccessor = source.addAccessor(sourceUvs, { componentType: 5126, count: 3, type: "VEC2" });
        const colorAccessor = source.addAccessor(sourceColors, { componentType: 5126, count: 3, type: "VEC4" });
        source.json.meshes[0].primitives[0].attributes.TEXCOORD_0 = uvAccessor;
        source.json.meshes[0].primitives[0].attributes.COLOR_0 = colorAccessor;

        const { json, bin } = await roundTrip(page, source);

        const primitive = json.meshes[0].primitives[0];
        expect(primitive.mode ?? 4).toBe(4);
        // COLOR_0 is deliberately absent: without enableDeviceLostSceneRecovery the loader keeps vertex colors on the GPU only,
        // so the exporter omits them with a warning (docs/lite/architecture/60-gltf-exporter.md, Scope).
        expect(Object.keys(primitive.attributes).sort()).toEqual(["NORMAL", "POSITION", "TEXCOORD_0"]);
        const position = json.accessors[primitive.attributes.POSITION];
        expect(position).toMatchObject({ componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] });
        const positions = readAccessor(json, bin, primitive.attributes.POSITION);
        const uvs = readAccessor(json, bin, primitive.attributes.TEXCOORD_0);
        const indices = primitive.indices === undefined ? [0, 1, 2] : readAccessor(json, bin, primitive.indices);
        const corners = indices.map((index) => positions.slice(index * 3, index * 3 + 3).join(",")).sort();
        expect(corners).toEqual(["0,0,0", "0,1,0", "1,0,0"]);

        const rows: number[][] = [];
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
            rows.push([...positions.slice(vertex * 3, vertex * 3 + 3), ...uvs.slice(vertex * 2, vertex * 2 + 2)]);
        }
        const expectedRows = [
            [0, 0, 0, 0, 0],
            [1, 0, 0, 1, 0],
            [0, 1, 0, 0, 1],
        ];
        const byPosition = (left: number[], right: number[]): number => left.slice(0, 3).join(",").localeCompare(right.slice(0, 3).join(","));
        expect(rows.sort(byPosition)).toEqual(expectedRows.sort(byPosition));
    });

    // https://github.com/BabylonJS/Babylon.js/pull/4590
    test("exports unit-length normals", async ({ page }) => {
        // Babylon.js overwrites the imported normals with (0, 0, 5) through setVerticesData. Lite has no mutator that updates
        // the retained CPU arrays, so the same non-unit normals are authored in the source document instead.
        const source = createTriangleFixture();
        source.bin.set(Buffer.from(new Float32Array([0, 0, 5, 0, 0, 5, 0, 0, 5]).buffer), 36);

        const { json, bin } = await roundTrip(page, source);

        const normals = readAccessor(json, bin, json.meshes[0].primitives[0].attributes.NORMAL);
        expect(normals).toHaveLength(9);
        for (let i = 0; i < normals.length; i += 3) {
            expect(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!)).toBeCloseTo(1);
        }
    });

    test("round trips perspective and orthographic cameras", async ({ page }) => {
        // Lite exports only scene.camera, and the harness adopts the first loaded camera, so each camera
        // is imported and exported in its own document with the Babylon.js values.
        const withCamera = (name: string, camera: GltfJson): GltfFixture => {
            const source = createTriangleFixture();
            source.json.nodes[0].children = [1];
            source.json.nodes.push({ name, camera: 0 });
            source.json.cameras = [camera];
            return source;
        };
        const perspective = await roundTrip(page, withCamera("persp", { name: "persp", type: "perspective", perspective: { yfov: 0.8, znear: 0.1, zfar: 50 } }));
        const orthographic = await roundTrip(page, withCamera("ortho", { name: "ortho", type: "orthographic", orthographic: { xmag: 4, ymag: 2, znear: 0.5, zfar: 20 } }));

        const persp = perspective.json.cameras?.find((c: GltfJson) => c.type === "perspective");
        const ortho = orthographic.json.cameras?.find((c: GltfJson) => c.type === "orthographic");
        if (!persp?.perspective || !ortho?.orthographic) {
            throw new Error("Expected perspective and orthographic cameras");
        }
        expect(persp.perspective.yfov).toBeCloseTo(0.8);
        expect(persp.perspective.znear).toBeCloseTo(0.1);
        expect(persp.perspective.zfar).toBeCloseTo(50);
        expect(ortho.orthographic).toMatchObject({ znear: 0.5, zfar: 20 });
        expect(ortho.orthographic.xmag / ortho.orthographic.ymag).toBeCloseTo(2);
    });
});

test.describe("Babylon.js glTFAnimation.test.ts", () => {
    test("round trips animation channels, interpolation modes and keyframe times", async ({ page }) => {
        const source = createTriangleFixture();
        const times = source.addAccessor(new Float32Array([0, 0.5, 1]), { componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [1] });
        const translations = source.addAccessor(new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0]), { componentType: 5126, count: 3, type: "VEC3" });
        const scales = source.addAccessor(new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]), { componentType: 5126, count: 3, type: "VEC3" });
        source.json.animations = [
            {
                name: "move",
                samplers: [
                    { input: times, output: translations, interpolation: "STEP" },
                    { input: times, output: scales, interpolation: "LINEAR" },
                ],
                channels: [
                    { sampler: 0, target: { node: 0, path: "translation" } },
                    { sampler: 1, target: { node: 0, path: "scale" } },
                ],
            },
        ];

        const { json, bin } = await roundTrip(page, source);

        const animations: GltfJson[] | undefined = json.animations;
        if (!animations) {
            throw new Error("Expected exported animations");
        }
        expect(animations).toHaveLength(1);
        const animation = animations[0]!;
        expect(animation.name).toBe("move");
        const interpolationByPath = Object.fromEntries(
            animation.channels.map((channel: GltfJson) => [channel.target.path, animation.samplers[channel.sampler].interpolation ?? "LINEAR"])
        );
        expect(interpolationByPath).toEqual({ translation: "STEP", scale: "LINEAR" });
        for (const channel of animation.channels as GltfJson[]) {
            const nodeIndex = channel.target.node;
            if (nodeIndex === undefined) {
                throw new Error("Expected animation channels to target nodes");
            }
            expect(json.nodes[nodeIndex].name).toBe("triangle");
            const sampler = animation.samplers[channel.sampler];
            expect(readAccessor(json, bin, sampler.input)).toEqual([0, 0.5, 1]);
            expect(readAccessor(json, bin, sampler.output)).toEqual(channel.target.path === "translation" ? [0, 0, 0, 1, 0, 0, 1, 2, 0] : [1, 1, 1, 2, 2, 2, 3, 3, 3]);
        }
    });
});

test.describe("Babylon.js glTFSkinsAndMorphTargets.test.ts", () => {
    test("round trips morph targets with their default weights and names", async ({ page }) => {
        const source = createTriangleFixture();
        const forward = source.addAccessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), { componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 1], max: [0, 0, 1] });
        const up = source.addAccessor(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), { componentType: 5126, count: 3, type: "VEC3", min: [0, 1, 0], max: [0, 1, 0] });
        source.json.meshes[0].primitives[0].targets = [{ POSITION: forward }, { POSITION: up }];
        source.json.meshes[0].weights = [0.25, 0.75];

        const { json, bin } = await roundTrip(page, source);

        // The Babylon.js test also asserts extras.targetNames ["forward", "up"]; the loader keeps no
        // morph-target names, so Lite does not export them (docs/lite/architecture/60-gltf-exporter.md, Scope).
        const mesh = json.meshes[0];
        const targets = mesh.primitives[0].targets;
        if (!targets || targets[0]?.POSITION === undefined || targets[1]?.POSITION === undefined) {
            throw new Error("Expected position morph target data");
        }
        expect(targets).toHaveLength(2);
        expect(mesh.weights).toEqual([0.25, 0.75]);
        expect(json.accessors[targets[0].POSITION]).toMatchObject({ count: 3, type: "VEC3" });
        expect(readAccessor(json, bin, targets[0].POSITION)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        expect(readAccessor(json, bin, targets[1].POSITION)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    });
});

test.describe("Babylon.js glTFMaterialExporter.test.ts", () => {
    /** Replace the fixture's material, export, and return the exported material of that name. */
    async function roundTripMaterial(page: Page, name: string, material: GltfJson): Promise<GltfJson> {
        const source = createTriangleFixture();
        source.json.materials[0] = { name, ...material };
        source.json.extensionsUsed = Object.keys(material.extensions ?? {});
        const { json } = await roundTrip(page, source);
        const exported = (json.materials as GltfJson[]).find((m) => m.name === name);
        if (!exported) {
            throw new Error(`Expected exported material ${name}`);
        }
        return exported;
    }

    test("round trips metallic-roughness factors, emissive and double-sidedness", async ({ page }) => {
        const material = await roundTripMaterial(page, "material0", {
            pbrMetallicRoughness: { baseColorFactor: [0.25, 0.5, 0.75, 1], metallicFactor: 0.6, roughnessFactor: 0.4 },
            emissiveFactor: [0.1, 0.2, 0.3],
            doubleSided: true,
        });

        const pbr = material.pbrMetallicRoughness;
        if (!pbr?.baseColorFactor || pbr.metallicFactor === undefined || pbr.roughnessFactor === undefined) {
            throw new Error("Expected metallic-roughness material factors");
        }
        // The loader bakes the base color into a 1x1 sRGB texture (8 bits per channel); the exporter folds it back, so each
        // channel is within half a sRGB byte step in linear space (at most 0.0045).
        expectValuesClose(pbr.baseColorFactor, [0.25, 0.5, 0.75, 1], 2);
        expect(pbr.metallicFactor).toBeCloseTo(0.6);
        expect(pbr.roughnessFactor).toBeCloseTo(0.4);
        expect(material.emissiveFactor).toEqual([0.1, 0.2, 0.3]);
        expect(material.doubleSided).toBe(true);
    });

    test("round trips the alpha modes", async ({ page }) => {
        const blend = await roundTripMaterial(page, "material1", { alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] } });
        const mask = await roundTripMaterial(page, "material2", { alphaMode: "MASK", alphaCutoff: 0.3, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
        const opaque = await roundTripMaterial(page, "material3", { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });

        expect(blend.alphaMode).toBe("BLEND");
        const blendBaseColor = blend.pbrMetallicRoughness?.baseColorFactor;
        if (!blendBaseColor || mask.alphaCutoff === undefined) {
            throw new Error("Expected alpha material factors");
        }
        expect(blendBaseColor[3]).toBeCloseTo(0.5);
        expect(mask.alphaMode).toBe("MASK");
        expect(mask.alphaCutoff).toBeCloseTo(0.3);
        expect(opaque.alphaMode ?? "OPAQUE").toBe("OPAQUE");
    });

    const extensions: Record<string, Record<string, number | number[]>> = {
        KHR_materials_ior: { ior: 1.8 },
        KHR_materials_emissive_strength: { emissiveStrength: 4 },
        KHR_materials_transmission: { transmissionFactor: 0.7 },
        KHR_materials_volume: { thicknessFactor: 0.5, attenuationDistance: 2, attenuationColor: [0.5, 0.6, 0.7] },
        KHR_materials_specular: { specularFactor: 0.4, specularColorFactor: [0.9, 0.8, 0.7] },
        KHR_materials_sheen: { sheenColorFactor: [0.3, 0.4, 0.5], sheenRoughnessFactor: 0.6 },
        KHR_materials_iridescence: { iridescenceFactor: 0.8, iridescenceIor: 1.4, iridescenceThicknessMinimum: 120, iridescenceThicknessMaximum: 450 },
        KHR_materials_anisotropy: { anisotropyStrength: 0.5, anisotropyRotation: 0.25 },
        KHR_materials_clearcoat: { clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.3 },
    };

    for (const name of Object.keys(extensions)) {
        test(`round trips ${name}`, async ({ page }) => {
            const material = await roundTripMaterial(page, `material_${name}`, {
                pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
                emissiveFactor: [1, 1, 1],
                ...(name === "KHR_materials_volume"
                    ? { extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, [name]: extensions[name] } }
                    : { extensions: { [name]: extensions[name] } }),
            });

            const round = (value: unknown): number[] => {
                const values = Array.isArray(value) ? value : [value];
                if (!values.every((item): item is number => typeof item === "number")) {
                    throw new Error("Expected numeric material extension values");
                }
                return values.map((item) => Math.round(item * 1e4) / 1e4);
            };
            const expected = Object.fromEntries(Object.entries(extensions[name]!).map(([key, value]) => [key, round(value)]));
            const extension = material.extensions?.[name];
            if (!extension || typeof extension !== "object") {
                throw new Error(`Expected exported ${name} extension`);
            }
            const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, round(extension[key])]));
            expect(actual).toEqual(expected);
        });
    }

    test("round trips unlit materials", async ({ page }) => {
        const material = await roundTripMaterial(page, "material_unlit", {
            pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] },
            extensions: { KHR_materials_unlit: {} },
        });

        if (!material.extensions?.KHR_materials_unlit || !material.pbrMetallicRoughness?.baseColorFactor) {
            throw new Error("Expected unlit material properties");
        }
        // 1x1 sRGB bake quantization, as in the metallic-roughness test above (at most 0.0045 per channel).
        expectValuesClose(material.pbrMetallicRoughness.baseColorFactor, [0.2, 0.4, 0.6, 1], 2);
    });
});
