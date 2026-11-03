import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { MaterialView } from "../../../packages/babylon-lite/src/material/material.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { _copyParallaxOcclusionProps, _writeParallaxUniforms } from "../../../packages/babylon-lite/src/material/parallax/parallax-occlusion.js";
import { _patchParallaxShader } from "../../../packages/babylon-lite/src/material/parallax/parallax-occlusion-shader.js";
import { pbrParallaxOcclusionExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/parallax-occlusion-fragment.js";
import { stdParallaxOcclusionExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-parallax-occlusion-fragment.js";
import { setPbrParallaxOcclusion } from "../../../packages/babylon-lite/src/material/pbr/set-parallax-occlusion.js";
import { setStandardParallaxOcclusion } from "../../../packages/babylon-lite/src/material/standard/set-std-parallax-occlusion.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { collectPbrBoundTextures } from "../../../packages/babylon-lite/src/material/pbr/collect-pbr-bound-textures.js";
import { collectStdBoundTextures } from "../../../packages/babylon-lite/src/material/standard/collect-std-bound-textures.js";
import { createStandardNoColorMaterialView } from "../../../packages/babylon-lite/src/material/standard/no-color-view.js";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material.js";
import { composeStandardGeometryShader } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader.js";
import { composePbrGeometryShader } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader.js";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { _computePbrMaterialFeatures } from "../../../packages/babylon-lite/src/material/pbr/pbr-material-features.js";
import { PBR_HAS_FOG } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits.js";
import { makeParallaxPbrFixture, makeParallaxStandardFixture, makeParallaxTexture, minifyParallaxTestWgsl } from "./parallax-occlusion-fixtures.js";

describe("parallax occlusion settings", () => {
    it("writes documented defaults and identity height UVs", () => {
        const data = new Float32Array(16);
        _writeParallaxUniforms(data, { heightTexture: makeParallaxTexture() }, 0, 4, 8, 12);
        expect(data[0]).toBeCloseTo(0.05);
        expect(Array.from(data.slice(1))).toEqual([0, 0, 0, 8, 32, 8, 0, 1, 0, -0, 1, 0, 0, 0, 0]);
    });

    it.each(["r", "g", "b", "a"] as const)("selects the %s height channel", (channel) => {
        const data = new Float32Array(16);
        _writeParallaxUniforms(data, { heightTexture: makeParallaxTexture(), heightChannel: channel }, 0, 4, 8, 12);
        expect(data[7]).toBe("rgba".indexOf(channel));
    });

    it.each([
        { heightScale: -1 },
        { heightScale: NaN },
        { heightScale: Infinity },
        { heightScale: Number.MAX_VALUE },
        { heightCenter: -0.1 },
        { heightCenter: 1.1 },
        { heightCenter: NaN },
        { minSteps: 0 },
        { minSteps: 1.5 },
        { maxSteps: 65 },
        { maxSteps: 1 },
        { refinementSteps: 0 },
        { refinementSteps: 33 },
    ])("rejects invalid settings before changing either material: %j", (invalid) => {
        const pbr = createPbrMaterial();
        const standard = createStandardMaterial();
        const props = { heightTexture: makeParallaxTexture(), ...invalid };
        expect(() => setPbrParallaxOcclusion(pbr, props)).toThrow(RangeError);
        expect(() => setStandardParallaxOcclusion(standard, props)).toThrow(RangeError);
        expect(pbr._parallaxOcclusion).toBeUndefined();
        expect(standard._parallaxOcclusion).toBeUndefined();
    });

    it("rejects unknown channels at the runtime boundary", () => {
        // @ts-expect-error Deliberately exercise the untyped caller boundary.
        expect(() => _copyParallaxOcclusionProps({ heightTexture: makeParallaxTexture(), heightChannel: "rg" })).toThrow(RangeError);
    });

    it.each(["depth32float", "r8uint", "rgba8sint", "r32float", "rg32float", "rgba32float"] as GPUTextureFormat[])("rejects unsupported height format %s", (format) => {
        expect(() => _copyParallaxOcclusionProps({ heightTexture: makeParallaxTexture(format) })).toThrow(TypeError);
    });

    it("requires linear RGB but accepts sRGB alpha", () => {
        const heightTexture = makeParallaxTexture("rgba8unorm-srgb");
        expect(() => _copyParallaxOcclusionProps({ heightTexture })).toThrow(/linear/);
        expect(_copyParallaxOcclusionProps({ heightTexture, heightChannel: "a" }).heightTexture).toBe(heightTexture);
    });

    it("rejects invalid height texture transforms", () => {
        const heightTexture = makeParallaxTexture();
        heightTexture.uScale = Infinity;
        expect(() => _copyParallaxOcclusionProps({ heightTexture })).toThrow(/uScale/);
    });

    it("copies settings, shares the texture, and supports null and zero-scale removal", () => {
        const props = { heightTexture: makeParallaxTexture(), heightScale: 0.1 };
        const pbr = createPbrMaterial();
        setPbrParallaxOcclusion(pbr, props);
        expect(pbr._parallaxOcclusion).not.toBe(props);
        expect(pbr._parallaxOcclusion?.heightTexture).toBe(props.heightTexture);
        props.heightScale = 0.2;
        expect(pbr._parallaxOcclusion?.heightScale).toBe(0.1);
        const active = _computePbrMaterialFeatures(pbr).features;
        setPbrParallaxOcclusion(pbr, { ...props, heightScale: 0 });
        expect(_computePbrMaterialFeatures(pbr).features).not.toBe(active);
        setPbrParallaxOcclusion(pbr, null);
        expect(pbr._parallaxOcclusion).toBeUndefined();

        const standard = createStandardMaterial();
        standard.diffuseTexture = props.heightTexture;
        setStandardParallaxOcclusion(standard, props);
        expect(stdParallaxOcclusionExt._detect!(standard)).not.toBe(0);
        setStandardParallaxOcclusion(standard, null);
        expect(stdParallaxOcclusionExt._detect!(standard)).toBe(0);
    });

    it("does not activate Standard displacement without a surface texture", () => {
        const material = createStandardMaterial();
        setStandardParallaxOcclusion(material, { heightTexture: makeParallaxTexture() });
        expect(stdParallaxOcclusionExt._detect!(material)).toBe(0);
    });

    it("composes material scale/offset, rotation, and invertY in the existing order", () => {
        const heightTexture = makeParallaxTexture();
        Object.assign(heightTexture, { uScale: 2, vScale: -3, uOffset: 0.2, vOffset: 0.4, uAng: 0.6, invertY: true });
        const data = new Float32Array(16);
        _writeParallaxUniforms(data, { heightTexture }, 0, 4, 8, 12, [4, 5], [0.1, 0.3]);
        const c = Math.cos(0.6);
        const s = Math.sin(0.6);
        expect(data[8]).toBeCloseTo(c * 8);
        expect(data[9]).toBeCloseTo(s * -15);
        expect(data[10]).toBeCloseTo(s * 8);
        expect(data[11]).toBeCloseTo(c * 15);
        expect(data[12]).toBeCloseTo(c * 2 * 0.1 + s * -3 * 0.3 + 0.2);
        expect(data[13]).toBeCloseTo(1 - (-s * 2 * 0.1 + c * -3 * 0.3 + 0.4));
    });
});

describe("parallax shader integration", () => {
    it("keeps the Standard parallax bit distinct from area-light receiver and emission bits", async () => {
        const fixture = await makeParallaxStandardFixture();
        const parallax = stdParallaxOcclusionExt._feature;
        expect(fixture.features & parallax).toBe(parallax);
        expect(parallax & ((1 << 28) | (1 << 29))).toBe(0);
    });

    it("keeps unopted PBR and Standard shaders free of parallax code", async () => {
        expect(makeParallaxPbrFixture({ enabled: false }).shader._fragmentWGSL).not.toContain("parallaxOffset");
        expect((await makeParallaxStandardFixture({ enabled: false })).shader._fragmentWGSL).not.toContain("parallaxOffset");
    });

    it("keeps the PBR material flag separate from scene fog", () => {
        const fixture = makeParallaxPbrFixture({ enabled: false });
        const shader = fixture.compose(fixture.features, fixture.features2, fixture.meshFeatures, PBR_HAS_FOG);
        expect(shader._fragmentWGSL).not.toContain("parallaxOffset");
    });

    it.each(["none", "cotangent", "tangent"] as const)("displaces PBR surface maps with %s normal mapping", (normal) => {
        const { shader } = makeParallaxPbrFixture({ normal });
        expect(shader._fragmentWGSL).toContain("parallaxSample(baseColorTexture,baseColorSampler,input.uv,parallaxScreenOffset)");
        expect(shader._fragmentWGSL).toContain("parallaxSample(ormTexture,ormSampler,input.uv,parallaxScreenOffset)");
        if (normal !== "none") {
            expect(shader._fragmentWGSL).toContain("parallaxSample(normalTexture,normalSampler_,input.uv,parallaxScreenOffset)");
        }
        if (normal === "cotangent") {
            expect(shader._fragmentWGSL).toContain("let duv1=dpdx(input.uv)");
        }
        expect(shader._fragmentWGSL).not.toContain("frag_depth");
    });

    it("preserves independently transformed and UV2 PBR channels", () => {
        const { shader } = makeParallaxPbrFixture({ normal: "cotangent", transforms: true, uv2: true, optionalTextures: true });
        for (const texture of [
            "baseColorTexture",
            "ormTexture",
            "normalTexture",
            "emissiveTexture",
            "occlusionTexture",
            "ccIntensityTexture",
            "ccRoughnessTexture",
            "ccNormalTexture",
            "sheenTexture_",
            "sheenRoughTexture_",
        ]) {
            expect(shader._fragmentWGSL).toContain(`parallaxSample(${texture},`);
        }
        expect(shader._fragmentWGSL).toContain("input.uv2");
        expect(shader._fragmentWGSL).toContain("baseColorUV");
    });

    it("displaces the specular/glossiness workflow at its own transformed UV", () => {
        const { shader } = makeParallaxPbrFixture({ normal: "cotangent", specGloss: true, transforms: true, uv2: true });
        expect(shader._fragmentWGSL).toContain("parallaxSample(specGlossTexture,specGlossSampler,specGlossUV,parallaxScreenOffset)");
    });

    it("displaces every Standard surface map without changing the normal frame", async () => {
        const { shader } = await makeParallaxStandardFixture({ normal: "cotangent", optionalTextures: true, transforms: true, uv2: true });
        for (const texture of ["dT", "eT", "bT", "sT", "aT", "lT", "oT"]) {
            expect(shader._fragmentWGSL).toContain(`parallaxSample(${texture},`);
        }
        expect(shader._fragmentWGSL).toContain("perturbNormal(input.vn,input.vp,input.vb,mat.bs,parallaxScreenOffset)");
        expect(shader._fragmentWGSL).toContain("let duv1 = dpdx(uv)");
        expect(shader._vertexWGSL).toContain("out.parallaxBaseUV=uv");
    });

    it("keeps late Standard geometry reflectivity sampling displaced", async () => {
        const fixture = await makeParallaxStandardFixture({ normal: "cotangent", optionalTextures: true, transforms: true });
        const shader = composeStandardGeometryShader(fixture.features, fixture.meshFeatures, fixture.fragments, [
            GeometryTextureType.REFLECTIVITY,
            GeometryTextureType.WORLD_NORMAL,
            GeometryTextureType.WORLD_POSITION,
        ]);
        const output = shader._fragmentWGSL.slice(shader._fragmentWGSL.indexOf("var out: FragmentOutput"));
        expect(output).toContain("parallaxSample(sT,sS,input.vs,parallaxScreenOffset).rgb");
        expect(output).toContain("parallaxSample(sT,sS,input.vs,parallaxScreenOffset).a");
        expect(output).toContain("input.vp");
        expect(output).not.toContain("textureSample(sT");
    });

    it("preserves PBR geometry outputs while displacing their material samples", () => {
        const fixture = makeParallaxPbrFixture({ normal: "cotangent" });
        const shader = composePbrGeometryShader(
            fixture.compose,
            fixture.features,
            fixture.features2,
            fixture.meshFeatures,
            0,
            0,
            "",
            "",
            undefined,
            "",
            [GeometryTextureType.WORLD_NORMAL, GeometryTextureType.ALBEDO, GeometryTextureType.WORLD_POSITION],
            false
        );
        expect(shader._fragmentWGSL).toContain("parallaxSample(normalTexture");
        expect(shader._fragmentWGSL).toContain("input.worldPos");
        expect(shader._fragmentWGSL).not.toContain("frag_depth");
    });

    it.each(["no-color", "esm"] as const)("omits shader and binding contributions in %s caster views", async (caster) => {
        const pairs = [
            [makeParallaxPbrFixture({ caster }).shader, makeParallaxPbrFixture({ caster, enabled: false }).shader],
            [(await makeParallaxStandardFixture({ caster })).shader, (await makeParallaxStandardFixture({ caster, enabled: false })).shader],
        ] as const;
        for (const [shader, baseline] of pairs) {
            expect(shader._fragmentWGSL).not.toContain("parallaxOffset");
            expect(shader._vertexWGSL).not.toContain("parallaxBaseUV");
            expect(shader._meshBGLDescriptor).toEqual(baseline._meshBGLDescriptor);
        }
    });

    it("handles nested coordinate expressions and leaves scene-space samplers alone", () => {
        const fixture = makeParallaxPbrFixture({ enabled: false });
        const shader = _patchParallaxShader(
            {
                ...fixture.shader,
                _fragmentWGSL: wgsl`${fixture.shader._fragmentWGSL.replace(
                    "textureSample(baseColorTexture,baseColorSampler,input.uv)",
                    "textureSample(baseColorTexture, baseColorSampler, vec2<f32>(input.uv.x, 1.0-input.uv.y))"
                )}
fn untouched()->vec4f{return textureSample(brdfLUT,brdfSampler_,vec2f(0.5));}`,
            },
            { _position: "input.worldPos", _normal: "input.worldNormal", _uv: "input.uv", _uniform: "material", _surfaceTextures: ["baseColorTexture"] }
        );
        expect(shader._fragmentWGSL).toContain("parallaxSample(baseColorTexture,baseColorSampler,vec2<f32>(input.uv.x, 1.0-input.uv.y),parallaxScreenOffset)");
        expect(shader._fragmentWGSL).toContain("textureSample(brdfLUT,brdfSampler_,vec2f(0.5))");
    });

    it("patches production-minified Standard normal-map code", async () => {
        const fixture = await makeParallaxStandardFixture({ normal: "cotangent", transforms: true });
        const parallax = fixture.fragments.find((fragment) => fragment._id === "parallax-occlusion")!;
        const deferred = fixture.fragments.map((fragment) => (fragment === parallax ? { ...fragment, _pc: undefined } : fragment));
        const { composeStandardShader } = await import("../../../packages/babylon-lite/src/material/standard/standard-pipeline.js");
        const original = composeStandardShader(fixture.features, fixture.meshFeatures, deferred);
        const shader = parallax._pc!({ ...original, _fragmentWGSL: minifyParallaxTestWgsl(original._fragmentWGSL) });
        expect(shader._fragmentWGSL).toContain("parallaxSample(bT,bS,uv,parallaxScreenOffset)");
        expect(shader._fragmentWGSL).toContain("parallaxScreenOffset:vec2f");
    });
});

describe("parallax bindings and ownership", () => {
    it("writes the PBR UBO slice and binds/enumerates the height texture", () => {
        const fixture = makeParallaxPbrFixture();
        const spec = fixture.shader._materialUboSpec!;
        const data = new Float32Array(spec._totalBytes / 4);
        pbrParallaxOcclusionExt.writeUbo!(data, fixture.material, spec._offsets);
        expect(data[spec._offsets.get("parallaxHeight")! / 4]).toBeCloseTo(0.05);
        const entries: GPUBindGroupEntry[] = [];
        expect(
            pbrParallaxOcclusionExt.bind!(
                {
                    _engine: {} as EngineContext,
                    _features: fixture.features,
                    _features2: fixture.features2,
                    _meshFeatures: 0,
                    _material: fixture.material,
                },
                entries,
                7
            )
        ).toBe(9);
        expect(entries).toEqual([
            { binding: 7, resource: fixture.texture.view },
            { binding: 8, resource: fixture.texture.sampler },
        ]);
        expect(collectPbrBoundTextures(fixture.material).filter((texture) => texture === fixture.texture)).toHaveLength(3);
    });

    it("owns and releases Standard's feature UBO through the binding disposers", async () => {
        const fixture = await makeParallaxStandardFixture();
        const destroy = vi.fn();
        const buffer = { destroy } as unknown as GPUBuffer;
        const writeBuffer = vi.fn();
        const engine = { _device: { createBuffer: vi.fn(() => buffer), queue: { writeBuffer } } } as unknown as EngineContext;
        const scene = { surface: { engine } } as SceneContext;
        const disposers: (() => void)[] = [];
        const entries: GPUBindGroupEntry[] = [];
        expect(stdParallaxOcclusionExt._bind!(fixture.material, entries, 4, undefined, scene, disposers)).toBe(7);
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(entries).toEqual([
            { binding: 4, resource: { buffer } },
            { binding: 5, resource: fixture.texture.view },
            { binding: 6, resource: fixture.texture.sampler },
        ]);
        expect(collectStdBoundTextures(fixture.material).filter((texture) => texture === fixture.texture)).toHaveLength(2);
        expect(disposers).toHaveLength(1);
        disposers[0]!();
        expect(destroy).toHaveBeenCalledOnce();

        const view = createStandardNoColorMaterialView(fixture.material) as MaterialView & StandardMaterialProps;
        expect(stdParallaxOcclusionExt._bind!(view, [], 4)).toBe(4);
    });
});
