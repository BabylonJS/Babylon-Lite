import { afterEach, describe, expect, it, vi } from "vitest";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose.js";
import { _getPbrSceneHooks, _registerPbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags.js";
import { _registerStdExt } from "../../../packages/babylon-lite/src/material/standard/standard-flags.js";
import {
    rectAreaPbrExt,
    rectAreaSingleLightSource,
    rectAreaMultiLightSource,
    RECT_AREA_PBR_SCENE,
    RECT_AREA_PBR_SELECTED,
} from "../../../packages/babylon-lite/src/material/pbr/fragments/rect-area-light-fragment.js";
import { rectAreaStandardContext, rectAreaStdExt } from "../../../packages/babylon-lite/src/material/standard/fragments/rect-area-light-fragment.js";
import { composeStandardShader, writeStdMaterialData } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { COMPUTE_PBR_LIGHT, getMultiLightLoop, MULTI_LIGHT_STRUCTS } from "../../../packages/babylon-lite/src/material/pbr/fragments/multilight-wgsl.js";
import { SINGLE_LIGHT_STRUCTS, getSingleLightBlock } from "../../../packages/babylon-lite/src/material/pbr/fragments/singlelight-point-wgsl.js";
import { createRectAreaLight } from "../../../packages/babylon-lite/src/light/rect-area-light.js";
import { enableRectAreaLights } from "../../../packages/babylon-lite/src/light/enable-rect-area-lights.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";
import type { ShaderFragment } from "../../../packages/babylon-lite/src/shader/fragment-types.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { buildNodeMeshRenderables } from "../../../packages/babylon-lite/src/material/node/node-renderable.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";

function composer(area: boolean) {
    _registerPbrExt(rectAreaPbrExt);
    const multi = area ? rectAreaMultiLightSource() : { _helpers: MULTI_LIGHT_STRUCTS() + COMPUTE_PBR_LIGHT, _loop: getMultiLightLoop() };
    return createPbrComposer({
        _singleLightWGSL: SINGLE_LIGHT_STRUCTS,
        _getSingleLightBlock: (type) => rectAreaSingleLightSource(type)?.getSingleLightBlock() ?? getSingleLightBlock(),
        _multiLightWGSL: multi._helpers,
        _multiLightLoop: multi._loop,
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: null,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
}

function ltcScene(): SceneContext {
    const engine = {
        _device: {
            createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
            createSampler: vi.fn(() => ({})),
            pushErrorScope: vi.fn(),
            popErrorScope: vi.fn(async () => null),
            queue: { writeTexture: vi.fn() },
        },
    } as unknown as EngineContext;
    return { surface: { engine }, lights: [createRectAreaLight([0, 0, 1], 2, 2)], _disposables: [] } as unknown as SceneContext;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("RectAreaLight material shader contributions", () => {
    it("emits selected-single-area LTC diffuse and material F0/F90 specular, not a point-light block", () => {
        const shader = composer(true)(0, 0, 0, RECT_AREA_PBR_SCENE, 1, "rectArea");
        const code = shader._fragmentWGSL;
        expect(code).toContain("let lightIndex = mli(0u)");
        expect(code).toContain("evaluateAreaLtc(N,V,input.worldPos,areaEntry,roughness)");
        expect(code).toContain("surfaceAlbedo * areaEntry.vLightDiffuse.rgb * area.diffuse * material.directIntensity");
        expect(code).toContain("colorF0 * areaColor * area.fresnel.x");
        expect(code).toContain("area.fresnel.y * colorF90");
        expect(code).toContain("areaColor * areaFresnel * area.specular");
        expect(code).not.toContain("computePbrLight");
        expect(code).not.toContain("lightDistance");
        expect(code.match(/var areaLtc[12]:\s*texture_2d<f32>/g)).toHaveLength(2);
        expect(code.match(/var areaLtc[12]Sampler:\s*sampler/g)).toHaveLength(2);
        expect(shader._fragmentKey).toBe("rect-area-light");
    });

    it("handles mixed rectangles before punctual lighting and never feeds packed axes into distance falloff", () => {
        const shader = composer(true)(0, 0, 0, RECT_AREA_PBR_SCENE, 2);
        const code = shader._fragmentWGSL;
        expect(code).toContain("if (u32(lights.lights[lightIndex].vLightData.w) == 4u)");
        expect(code).toContain("computeRectPbrLight(entry0");
        expect(code).toContain("return PbrLightResult(N,0.0,0.0");
        expect(code).toContain("return computePbrLight(entry,N,P,falloff)");
        expect(code.indexOf("let areaEntry = lights.lights[lightIndex]")).toBeLessThan(code.indexOf("if (li == 0u)"));
        expect(code).toContain("continue;");
        expect(shader._meshBGLDescriptor.entries).toHaveLength(10);
    });

    it("couples LTC texture declarations with helpers and uses exact winding, matrix and clipping coefficients", () => {
        const code = composer(true)(0, 0, 0, RECT_AREA_PBR_SCENE, 1, "rectArea")._fragmentWGSL;
        expect(code).toContain("entry.vLightDiffuse.w, entry.vLightSpecular.w, entry.vLightDirection.x");
        expect(code).toContain("let B = entry.vLightDirection.yzw");
        expect(code).toContain("cross(-2.0 * A, 2.0 * B)");
        expect(code).toContain("dot(normal,-p0) < 0.0");
        expect(code).toContain("(63.0 / 64.0)");
        expect(code).toContain("transpose(mat3x3<f32>(T,-cross(N,T),N))");
        expect(code).toContain("0.8543985");
        expect(code).toContain("3.4175940");
        expect(code).toContain("(dot(f,f) + f.z) / (length(f) + 1.0)");
        expect(code).toContain("textureSampleLevel(areaLtc1");
        expect(code).toContain("textureSampleLevel(areaLtc2");
    });

    it("leaves non-area and zero-selected-light shaders free of LTC resources and helpers", () => {
        expect(composer(false)(0, 0, 0, 0, 1, "point")._fragmentWGSL).not.toContain("areaLtc");
        const noLights = composer(true)(0, 0, 0, RECT_AREA_PBR_SCENE, 0);
        expect(noLights._fragmentWGSL).not.toContain("evaluateAreaLtc");
        expect(noLights._fragmentKey).toBe("");
        expect(rectAreaSingleLightSource("point")).toBeUndefined();
    });

    it("explicitly rejects unsupported layered PBR rather than approximating polygonal BRDFs", () => {
        expect(() => composer(true)(1 << 20, 0, 0, RECT_AREA_PBR_SCENE | RECT_AREA_PBR_SELECTED, 1, "rectArea")).toThrow(/layered PBR/);
    });

    it("preserves Standard LTC roughness independently of glossiness and material diffuse/specular multiplication", () => {
        _registerStdExt(rectAreaStdExt);
        const context = rectAreaStandardContext(null);
        const fragment = rectAreaStdExt._frag(context._materialFeatures!);
        const shader = composeStandardShader(context._materialFeatures!, 0, [fragment], "", context);
        expect(shader._fragmentWGSL).toContain("evaluateAreaLtc(N,viewDir,P,L,mat._0)");
        expect(shader._fragmentWGSL).toContain("color * area.fresnel.x + (vec3<f32>(1.0) - color) * area.fresnel.y");
        expect(shader._fragmentWGSL).toContain("specularBase * specularColor");
        expect(shader._fragmentWGSL).toContain("diffuseBase * diffuseColor");
        expect(shader._meshBGLDescriptor.entries).toHaveLength(6);
        const material = createStandardMaterial();
        const data = new Float32Array(24);
        material.roughness = 0.9;
        material.specularPower = 128;
        writeStdMaterialData(data, material, 1);
        expect(data[22]).toBeCloseTo(0.9);
        expect(data[7]).toBe(128);
        material.roughness = undefined;
        writeStdMaterialData(data, material, 1);
        expect(data[22]).toBe(0);
    });

    it("keeps Standard fog contributions when area lighting is enabled", () => {
        const fog: ShaderFragment = { _id: "fog", _fragmentSlots: { BC: wgsl`color = vec4<f32>(color.rgb * 0.9,color.a);` } };
        const context = rectAreaStandardContext(fog);
        expect(context._fragments).toEqual([fog]);
        const shader = composeStandardShader(context._materialFeatures!, 0, [rectAreaStdExt._frag(context._materialFeatures!)], "", context);
        expect(shader._fragmentWGSL).toContain("color.rgb * 0.9");
        expect(shader._fragmentWGSL).toContain("evaluateAreaLtc");
    });

    it("enables lazily, explicitly rejects Node lighting at its real build seam, and permits unlit graphs", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const scene = ltcScene();
        await enableRectAreaLights(scene);
        expect(() => scene.lights[0]!._validateLighting!(scene._lighting)).not.toThrow();
        expect(() => scene._lighting!._validateNode!(false)).not.toThrow();
        const mesh = { material: { _state: { usesLightsUbo: true } } } as unknown as Mesh;
        expect(() => buildNodeMeshRenderables(scene, [mesh])).toThrow(/NodeMaterial lighting blocks/);
        scene._disposables.forEach((dispose) => dispose());
    });

    it("prepares replacement-device LUT handles through the existing awaited PBR scene hooks", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const scene = ltcScene();
        await enableRectAreaLights(scene);
        const replacement = ltcScene();
        scene.surface.engine._device = replacement.surface.engine._device;
        for (const hook of _getPbrSceneHooks()) {
            await hook(scene, scene.surface.engine, []);
        }
        expect(replacement.surface.engine._device.createTexture).toHaveBeenCalledTimes(2);
        scene._disposables.forEach((dispose) => dispose());
    });
});
