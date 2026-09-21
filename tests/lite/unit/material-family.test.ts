import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getMaterialTextureBindings, inspectMaterial, setMaterialInspectionProperty } from "../../../packages/babylon-lite/src/inspection/material-inspection";
import { getMaterialFamily } from "../../../packages/babylon-lite/src/material/material-family";
import { getMaterialTextures } from "../../../packages/babylon-lite/src/material/material-textures";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { isPbrMaterial, isStandardMaterial, isShaderMaterial, isNodeMaterial } from "../../../packages/babylon-lite/src/material/material-guards";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createShaderMaterial, setShaderTexture } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

/** Device-free material stub: getMaterialFamily only reads `_buildGroup._materialFamily`
 *  (unwrapping a view to its source first). */
function fakeMaterial(family?: string): Material {
    return {
        _buildGroup: { _materialFamily: family } as unknown as Material["_buildGroup"],
        _uboVersion: 0,
    } as Material;
}

function texture2d(seed: number): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 1,
        height: 1,
        _sampleType: "float",
    };
}

describe("getMaterialFamily", () => {
    it("returns the core family strings", () => {
        expect(getMaterialFamily(fakeMaterial("pbr"))).toBe("pbr");
        expect(getMaterialFamily(fakeMaterial("standard"))).toBe("standard");
        expect(getMaterialFamily(fakeMaterial("shader"))).toBe("shader");
        expect(getMaterialFamily(fakeMaterial("node"))).toBe("node");
    });

    it("returns undefined when a material declares no family", () => {
        expect(getMaterialFamily(fakeMaterial(undefined))).toBeUndefined();
    });

    it("returns undefined (no throw) for a plain material-like object with no builder", () => {
        // _buildGroup is @internal / trimmed from the public d.ts, so callers can legally
        // pass a bare { name, metadata } typed as Material.
        expect(getMaterialFamily({ name: "plain" } as unknown as Material)).toBeUndefined();
    });

    it("reports a custom builder's own family string", () => {
        expect(getMaterialFamily(fakeMaterial("myCustomType"))).toBe("myCustomType");
    });

    it("reports the source family through a material view", () => {
        const source = fakeMaterial("pbr");
        const view = createMaterialView(source, { features: 0 });
        expect(getMaterialFamily(view)).toBe("pbr");
    });
});

describe("material type guards", () => {
    it("each guard matches only its own family", () => {
        const pbr = fakeMaterial("pbr");
        const standard = fakeMaterial("standard");
        const shader = fakeMaterial("shader");
        const node = fakeMaterial("node");

        expect(isPbrMaterial(pbr)).toBe(true);
        expect(isPbrMaterial(standard)).toBe(false);

        expect(isStandardMaterial(standard)).toBe(true);
        expect(isStandardMaterial(pbr)).toBe(false);

        expect(isShaderMaterial(shader)).toBe(true);
        expect(isShaderMaterial(node)).toBe(false);

        expect(isNodeMaterial(node)).toBe(true);
        expect(isNodeMaterial(shader)).toBe(false);
    });

    it("returns false for a family-less material", () => {
        const unknown = fakeMaterial(undefined);
        expect(isPbrMaterial(unknown)).toBe(false);
        expect(isStandardMaterial(unknown)).toBe(false);
        expect(isShaderMaterial(unknown)).toBe(false);
        expect(isNodeMaterial(unknown)).toBe(false);
    });

    it("matches through a material view over a typed source", () => {
        const view = createMaterialView(fakeMaterial("pbr"), { features: 0 });
        expect(isPbrMaterial(view)).toBe(true);
        expect(isStandardMaterial(view)).toBe(false);
    });
});

describe("getMaterialTextures", () => {
    const texture = texture2d(1);
    const otherTexture = texture2d(2);

    it("preserves canonical Standard/PBR ordering and duplicate bindings while omitting absent and cube slots", () => {
        const cube = {};
        const standard = {
            ...fakeMaterial("standard"),
            diffuseTexture: texture,
            _emissiveTexture: texture,
            _bumpTexture: null,
            _specularTexture: otherTexture,
            _reflectionCubeTexture: cube,
        };
        const pbr = {
            ...fakeMaterial("pbr"),
            baseColorTexture: texture,
            normalTexture: otherTexture,
            ormTexture: texture,
            lightmapTexture: otherTexture,
            _clearCoat: {
                texture,
                roughnessTexture: null,
                bumpTexture: otherTexture,
            },
        };

        expect(getMaterialTextures(standard)).toEqual([texture, texture, otherTexture]);
        expect(getMaterialTextures(pbr)).toEqual([texture, otherTexture, texture, otherTexture, texture, otherTexture]);
    });

    it("uses Shader declaration order and Node lexical input order", () => {
        const shader = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
            attributes: ["position"],
            samplers: ["zeta", "empty", "alpha"],
        });
        setShaderTexture(shader, "zeta", texture);
        setShaderTexture(shader, "alpha", otherTexture);
        const node = {
            ...fakeMaterial("node"),
            inputs: {
                zeta: { type: "texture2d", texture },
                alpha: { type: "texture2d", texture: otherTexture },
                value: { type: "f32", value: 1 },
            },
        };
        Object.setPrototypeOf(node.inputs, { inherited: { type: "texture2d", texture: otherTexture } });

        expect(getMaterialTextures(shader)).toEqual([texture, otherTexture]);
        expect(getMaterialTextures(node)).toEqual([otherTexture, texture]);
    });

    it("unwraps material views and returns no textures for unknown families", () => {
        const source = {
            ...fakeMaterial("standard"),
            diffuseTexture: texture,
        };

        expect(getMaterialTextures(createMaterialView(source, { features: 0 }))).toEqual([texture]);
        expect(getMaterialTextures(fakeMaterial("unknown"))).toEqual([]);
    });

    it("projects directly from the canonical binding seam without legacy family scanners", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/material/material-textures.ts"), "utf-8");

        expect(source).toMatch(/\bgetMaterialTextureBindings\s*\(/);
        expect(source).not.toMatch(/_getStdTextureCollectors|_getPbrTextureCollectors|_textureSlots|\.inputs\b/);
    });
});

describe("canonical material inspection dispatch", () => {
    const texture = texture2d(3);
    const shader = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
        attributes: ["position"],
        samplers: ["color"],
    });
    setShaderTexture(shader, "color", texture);
    const node = {
        ...fakeMaterial("node"),
        inputs: {
            color: { type: "texture2d", texture },
        },
    };

    it("selects each core family by canonical identity and keeps MaterialView source identity", () => {
        const materials = [fakeMaterial("standard"), fakeMaterial("pbr"), shader, node as unknown as Material];

        expect(materials.map((material) => inspectMaterial(material).family)).toEqual(["standard", "pbr", "shader", "node"]);
        expect(materials.map((material) => inspectMaterial(material).source)).toEqual(materials);
        expect(materials.map((material) => inspectMaterial(material).textureBindings[0]?.id)).toEqual([
            "standard.diffuse",
            "pbr.baseColor",
            "shader.sampler:color",
            "node.texture:color",
        ]);

        const view = createMaterialView(shader, { features: 0 });
        const snapshot = inspectMaterial(view);
        expect(snapshot).toMatchObject({ source: shader, family: "shader", isView: true });
        expect(getMaterialTextureBindings(view).map(({ id }) => id)).toEqual(["shader.sampler:color"]);
    });

    it("keeps dispatcher descriptors static and free of eager registries", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/inspection/material-inspection.ts"), "utf-8");

        expect(source).toMatch(/standardMaterialInspectionDescriptor/);
        expect(source).toMatch(/pbrMaterialInspectionDescriptor/);
        expect(source).toMatch(/shaderMaterialInspectionDescriptor/);
        expect(source).toMatch(/nodeMaterialInspectionDescriptor/);
        expect(source).not.toMatch(/\bnew (?:Map|Set|WeakMap)\s*\(/);
        expect(source).not.toMatch(/\bregister[A-Z]\w*Descriptor\s*\(/);
    });

    it("routes property mutations through every core family descriptor", async () => {
        const standard = {
            ...fakeMaterial("standard"),
            alphaCutOff: 0.1,
        };
        const pbr = {
            ...fakeMaterial("pbr"),
            environmentIntensity: 1,
        };
        const mutableShader = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
            attributes: ["position"],
            uniforms: [{ name: "amount", type: "f32", defaultValue: 1 }],
        });
        const amount = { type: "f32" as const, value: 1 };
        const mutableNode = {
            ...fakeMaterial("node"),
            inputs: { amount },
        };

        await expect(setMaterialInspectionProperty({ scenes: [] }, standard, "standard.alphaCutOff", 0.2)).resolves.toMatchObject({
            changed: true,
            mutation: "U",
        });
        await expect(setMaterialInspectionProperty({ scenes: [] }, pbr, "pbr.environmentIntensity", 0.5)).resolves.toMatchObject({
            changed: true,
            mutation: "U",
        });
        await expect(setMaterialInspectionProperty({ scenes: [] }, mutableShader, "shader.uniform:amount", 2)).resolves.toMatchObject({
            changed: true,
            mutation: "A",
        });
        await expect(setMaterialInspectionProperty({ scenes: [] }, mutableNode as unknown as Material, "node.input:amount", 3)).resolves.toMatchObject({
            changed: true,
            mutation: "A",
        });

        expect(standard.alphaCutOff).toBe(0.2);
        expect(pbr.environmentIntensity).toBe(0.5);
        expect(mutableShader._uniformValues.get("amount")?.value[0]).toBe(2);
        expect(amount.value).toBe(3);
    });
});
