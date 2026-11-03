import ts from "typescript";
import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { ComposedShader, ShaderFragment } from "../../../packages/babylon-lite/src/shader/fragment-types.js";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material.js";
import type { ParallaxOcclusionProps } from "../../../packages/babylon-lite/src/material/parallax/parallax-occlusion.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose.js";
import { createPbrTemplateExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-template-ext.js";
import * as tangentNormal from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-normal-tangent-wgsl.js";
import * as cotangentNormal from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-normal-cotangent-wgsl.js";
import * as specGloss from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-spec-gloss-wgsl.js";
import { _computePbrMaterialFeatures } from "../../../packages/babylon-lite/src/material/pbr/pbr-material-features.js";
import { PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT, PBR_HAS_ENV } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits.js";
import { _registerPbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags.js";
import { pbrExt as iblExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment.js";
import { setPbrParallaxOcclusion } from "../../../packages/babylon-lite/src/material/pbr/set-parallax-occlusion.js";
import { setPbrEmissive } from "../../../packages/babylon-lite/src/material/pbr/set-emissive.js";
import { setPbrClearCoat } from "../../../packages/babylon-lite/src/material/pbr/set-clearcoat.js";
import { setPbrSheen } from "../../../packages/babylon-lite/src/material/pbr/set-sheen.js";
import { enableMaterialUvTransform } from "../../../packages/babylon-lite/src/material/enable-material-uv-transform.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { _computeStandardMaterialFeatures } from "../../../packages/babylon-lite/src/material/standard/standard-material-features.js";
import { composeStandardShader } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline.js";
import { _getStdExtsSorted, ESM_SHADOW_OUTPUT, NO_COLOR_OUTPUT } from "../../../packages/babylon-lite/src/material/standard/standard-flags.js";
import { setStandardParallaxOcclusion } from "../../../packages/babylon-lite/src/material/standard/set-std-parallax-occlusion.js";
import { setStandardBumpTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-bump.js";
import { setStandardEmissiveTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-emissive.js";
import { setStandardSpecularTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-specular.js";
import { setStandardAmbientTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-ambient.js";
import { setStandardLightmapTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-lightmap.js";
import { setStandardOpacityTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-opacity.js";
import { MSH_HAS_TANGENTS, MSH_HAS_UV2 } from "../../../packages/babylon-lite/src/material/mesh-features.js";
import { transformTaggedWgsl } from "../../../scripts/wgsl-minify-plugin.js";

export function makeParallaxTexture(format: GPUTextureFormat = "rgba8unorm"): Texture2D {
    const view = { label: "parallax-test-view" } as GPUTextureView;
    return {
        texture: { format, createView: () => view } as unknown as GPUTexture,
        view,
        sampler: { label: "parallax-test-sampler" } as GPUSampler,
        width: 64,
        height: 64,
    };
}

export function minifyParallaxTestWgsl(source: string): WgslSource {
    const transformed = transformTaggedWgsl(`import { wgsl } from "./wgsl.js"; export const shader = wgsl\`${source}\`;`, "parallax-test.ts");
    if (!transformed) {
        throw new Error("WGSL minification did not transform the test shader.");
    }
    const file = ts.createSourceFile("parallax-test.ts", transformed.code, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
        if (ts.isVariableStatement(statement)) {
            const initializer = statement.declarationList.declarations[0]?.initializer;
            if (initializer && ts.isNoSubstitutionTemplateLiteral(initializer)) {
                return wgsl`${initializer.text}`;
            }
        }
    }
    throw new Error("WGSL minification did not preserve the tagged shader literal.");
}

interface FixtureOptions {
    enabled?: boolean;
    normal?: "none" | "cotangent" | "tangent";
    transforms?: boolean;
    optionalTextures?: boolean;
    specGloss?: boolean;
    uv2?: boolean;
    caster?: "no-color" | "esm";
    settings?: Partial<ParallaxOcclusionProps>;
}

const ESM_DEPTH_CODE = "return vec4<f32>(1.0);";

interface ParallaxPbrFixture {
    material: PbrMaterialProps;
    texture: Texture2D;
    shader: ComposedShader;
    compose: ReturnType<typeof createPbrComposer>;
    features: number;
    features2: number;
    meshFeatures: number;
}

interface ParallaxStandardFixture {
    material: StandardMaterialProps;
    texture: Texture2D;
    shader: ComposedShader;
    features: number;
    meshFeatures: number;
    fragments: ShaderFragment[];
}

export function makeParallaxPbrFixture(options: FixtureOptions = {}): ParallaxPbrFixture {
    const texture = makeParallaxTexture();
    const material = createPbrMaterial({ baseColorTexture: texture, ormTexture: texture });
    if (options.normal && options.normal !== "none") {
        material.normalTexture = texture;
    }
    if (options.specGloss) {
        material.specGlossTexture = texture;
    }
    if (options.optionalTextures) {
        _registerPbrExt(iblExt);
        material.emissiveTexture = texture;
        material.occlusionTexture = texture;
        setPbrEmissive(material, [0.1, 0.1, 0.1]);
        setPbrClearCoat(material, { isEnabled: true, texture, roughnessTexture: makeParallaxTexture(), bumpTexture: texture });
        setPbrSheen(material, { isEnabled: true, color: [1, 1, 1], texture, roughnessTexture: makeParallaxTexture() });
    }
    if (options.transforms) {
        enableMaterialUvTransform(material);
    }
    if (options.uv2) {
        material._uv2Mask = 1 | 2 | 4 | 8 | 16 | 32;
        material.occlusionTexCoord = 1;
    }
    if (options.enabled !== false) {
        setPbrParallaxOcclusion(material, { heightTexture: texture, ...options.settings });
    }
    const detected = _computePbrMaterialFeatures(material);
    const features2 = detected.features2 | (options.caster === "no-color" ? PBR2_NO_COLOR_OUTPUT : options.caster === "esm" ? PBR2_ESM_SHADOW_OUTPUT : 0);
    const meshFeatures = (options.normal === "tangent" ? MSH_HAS_TANGENTS : 0) | (options.uv2 ? MSH_HAS_UV2 : 0);
    const compose = createPbrComposer({
        _singleLightWGSL: "",
        _getSingleLightBlock: null,
        _multiLightWGSL: "",
        _multiLightLoop: "",
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: createPbrTemplateExt,
        _flatNormalWgsl: "",
        _tangentNormal: tangentNormal,
        _cotangentNormal: cotangentNormal,
        _specGloss: specGloss,
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
    const shader = compose(
        detected.features,
        features2,
        meshFeatures,
        options.optionalTextures ? PBR_HAS_ENV : 0,
        0,
        "",
        options.caster === "esm" ? ESM_DEPTH_CODE : "",
        undefined,
        "",
        material._uv2Mask
    );
    return { material, texture, shader, compose, features: detected.features, features2, meshFeatures };
}

export async function makeParallaxStandardFixture(options: FixtureOptions = {}): Promise<ParallaxStandardFixture> {
    const texture = makeParallaxTexture();
    const material = createStandardMaterial();
    material.diffuseTexture = texture;
    if (options.normal && options.normal !== "none") {
        setStandardBumpTexture(material, texture);
    }
    if (options.optionalTextures) {
        setStandardEmissiveTexture(material, texture);
        setStandardSpecularTexture(material, texture);
        setStandardAmbientTexture(material, texture);
        setStandardLightmapTexture(material, texture);
        setStandardOpacityTexture(material, texture);
    }
    if (options.uv2) {
        material.diffuseCoordIndex = 1;
        material.specularCoordIndex = 1;
        material.ambientCoordIndex = 1;
        material.lightmapCoordIndex = 1;
    }
    if (options.transforms) {
        enableMaterialUvTransform(material);
        await material._uvTxExt;
    }
    if (options.enabled !== false) {
        setStandardParallaxOcclusion(material, { heightTexture: texture, ...options.settings });
    }
    const meshFeatures = options.uv2 ? MSH_HAS_UV2 : 0;
    let features = _computeStandardMaterialFeatures(material) | (options.caster === "no-color" ? NO_COLOR_OUTPUT : options.caster === "esm" ? ESM_SHADOW_OUTPUT : 0);
    const fragments: ShaderFragment[] = [];
    for (const ext of _getStdExtsSorted()) {
        features |= ext._meshFeatures?.(meshFeatures, material) ?? 0;
        if (features & ext._feature) {
            fragments.push(ext._frag(features, meshFeatures, material));
        }
    }
    material._renderFeatures = { features };
    const shader = composeStandardShader(features, meshFeatures, fragments, options.caster === "esm" ? ESM_DEPTH_CODE : "");
    return { material, texture, shader, features, meshFeatures, fragments };
}
