import { describe, expect, it } from "vitest";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import { _packSceneUniforms } from "../../../../packages/babylon-lite/src/frame-graph/scene-uniforms-pack.js";
import { composeMeshLoDWgsl, meshLoDShaderKey, type MeshLoDShaderFeatures } from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-compose.js";
import { PBR_DISPLAY_OUTPUT_WGSL, PBR_EXPOSURE_WGSL } from "../../../../packages/babylon-lite/src/material/pbr/pbr-image-processing-output-wgsl.js";
import { createPbrTemplate } from "../../../../packages/babylon-lite/src/material/pbr/pbr-template.js";
import { StandardToneMapping, type ToneMapping } from "../../../../packages/babylon-lite/src/material/pbr/tone-mapping.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import { SCENE_UBO_BYTES } from "../../../../packages/babylon-lite/src/shader/scene-uniforms-size.js";

const features: MeshLoDShaderFeatures = {
    hasNormalMap: false,
    hasEmissiveTexture: false,
    hasIbl: false,
    hasSpecularAA: false,
    doubleSided: false,
    unlit: false,
};

const customToneMapping: ToneMapping = {
    id: "test-custom",
    helpersWGSL: "fn testToneCurve(c: vec3<f32>) -> vec3<f32> { return c / (c + vec3<f32>(1.0)); }",
    callWGSL: "color *= scene.vImageInfos.x;\ncolor = testToneCurve(color);",
};

const originalPbrDisplayOutput = `color=pow(color,vec3<f32>(1.0/2.2));
color=clamp(color,vec3<f32>(0.0),vec3<f32>(1.0));
let highContrast=color*color*(3.0-2.0*color);
if(scene.vImageInfos.y<1.0){color=mix(vec3<f32>(0.5),color,scene.vImageInfos.y);}
else{color=mix(color,highContrast,scene.vImageInfos.y-1.0);}
color=max(color,vec3<f32>(0.0));`;

it("preserves the ordinary PBR image-processing WGSL byte-for-byte after extraction", () => {
    expect(PBR_EXPOSURE_WGSL).toBe("color*=scene.vImageInfos.x;");
    expect(PBR_DISPLAY_OUTPUT_WGSL).toBe(originalPbrDisplayOutput);
    for (const toneMapping of [undefined, StandardToneMapping, customToneMapping]) {
        const call = toneMapping?.callWGSL ?? PBR_EXPOSURE_WGSL;
        for (const _normalMode of ["none", "tangent", "cotangent"] as const) {
            const shader = createPbrTemplate({
                _normalMode,
                _hasTonemap: !!toneMapping,
                _toneMappingHelpers: toneMapping?.helpersWGSL,
                _toneMappingCall: toneMapping?.callWGSL,
            })._fragmentTemplate;
            expect(shader).toContain(`${call}\n${originalPbrDisplayOutput}\n/*BC*/`);
        }
    }
});

function verifyOutput(shader: string, toneMapping?: ToneMapping): void {
    const call = toneMapping?.callWGSL ?? PBR_EXPOSURE_WGSL;
    const output = `${call}\n${PBR_DISPLAY_OUTPUT_WGSL}`;
    expect(shader).toContain(output);
    expect(shader.indexOf("color=max(color,vec3<f32>(0.0));")).toBeLessThan(shader.indexOf("let dbg = mlodDebugColor("));
    expect(shader).not.toContain("scene.vImageInfos.w >= 1.0");
    expect(shader).not.toContain("vec3<f32>(1.0) - exp(-color)");
}

describe.each([false, true])("MeshLoD %s image processing", (unlit) => {
    const variant = { ...features, unlit };

    it("shares ordinary PBR exposure, display gamma and contrast for live exposure 0.8 / contrast 1.2", () => {
        const shader = composeMeshLoDWgsl(variant, StandardToneMapping);
        const ordinary = createPbrTemplate({
            _hasTonemap: true,
            _toneMappingCall: StandardToneMapping.callWGSL,
        })._fragmentTemplate;
        verifyOutput(shader, StandardToneMapping);
        expect(ordinary).toContain(`${StandardToneMapping.callWGSL}\n${PBR_DISPLAY_OUTPUT_WGSL}`);
        expect(shader).toContain("color=pow(color,vec3<f32>(1.0/2.2))");
        expect(shader).toContain("else{color=mix(color,highContrast,scene.vImageInfos.y-1.0);}");
        expect(shader).toContain(StandardToneMapping.callWGSL);
        expect(shader).not.toContain("fn testToneCurve");
        if (unlit) {
            expect(shader).toContain("var color = baseSample.rgb * material.baseColorFactor.rgb;");
        } else {
            expect(shader).toContain("var color = diffuseIbl + specIbl + directDiffuse + directSpecular * energyConservation + emissive;");
        }
    });

    it("injects the selected custom tone-mapping algorithm before the shared display stage", () => {
        const shader = composeMeshLoDWgsl(variant, customToneMapping);
        verifyOutput(shader, customToneMapping);
        expect(shader).toContain(customToneMapping.helpersWGSL);
        expect(shader).not.toContain(StandardToneMapping.callWGSL);
        expect(meshLoDShaderKey(variant, customToneMapping)).not.toBe(meshLoDShaderKey(variant, StandardToneMapping));
        expect(meshLoDShaderKey(variant, customToneMapping)).not.toBe(meshLoDShaderKey(variant));
    });

    it("keeps exposure, gamma and contrast but omits the curve when tone mapping is disabled", () => {
        const shader = composeMeshLoDWgsl(variant);
        const ordinary = createPbrTemplate({ _hasTonemap: false })._fragmentTemplate;
        verifyOutput(shader);
        expect(ordinary).toContain(`${PBR_EXPOSURE_WGSL}\n${PBR_DISPLAY_OUTPUT_WGSL}`);
        expect(shader).not.toContain(StandardToneMapping.callWGSL);
        expect(shader).not.toContain(customToneMapping.helpersWGSL);
        expect(shader).not.toContain(customToneMapping.callWGSL);
    });
});

it("packs nondefault exposure and contrast live in the scene UBO used by both paths", () => {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    const camera = {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 100,
        worldMatrix,
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
        _viewVer: -1,
        _projVer: -1,
        _vpVer: -1,
        _projAspect: -1,
        _vpAspect: -1,
        _useFloatingOrigin: false,
    } as unknown as Camera;
    const engine = { canvas: { width: 800, height: 600 }, useFloatingOrigin: false } as EngineContext;
    const scene = { imageProcessing: { exposure: 0.8, contrast: 1.2, toneMappingEnabled: true, toneMapping: customToneMapping } } as SceneContext;
    const data = new Float32Array(SCENE_UBO_BYTES / 4);

    _packSceneUniforms(data, engine, scene, camera, 4 / 3);
    expect(data[76]).toBeCloseTo(0.8);
    expect(data[77]).toBeCloseTo(1.2);
    scene.imageProcessing.exposure = 1.4;
    scene.imageProcessing.contrast = 0.75;
    _packSceneUniforms(data, engine, scene, camera, 4 / 3);
    expect(data[76]).toBeCloseTo(1.4);
    expect(data[77]).toBeCloseTo(0.75);
});
