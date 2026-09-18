import { describe, expect, it } from "vitest";

import { MeshBlendDebugMode, MeshBlendDepthType, MeshBlendQuality } from "../../../packages/babylon-lite/src/post-process/mesh-blending";
import { createMeshBlendingWGSL } from "../../../packages/babylon-lite/src/post-process/mesh-blending-wgsl";

function shader(quality = MeshBlendQuality.Medium, depthType = MeshBlendDepthType.View, debugMode = MeshBlendDebugMode.Off, hasBaseColor = false): string {
    return createMeshBlendingWGSL({ quality, depthType, debugMode, hasBaseColor });
}

describe("mesh-blending WGSL bindings and coordinates", () => {
    it("uses exact texel loads, a typed integer tag texture, and no samplers", () => {
        const code = shader();
        expect(code).toContain("@group(0) @binding(0) var sourceTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(1) var tagTexture:texture_2d<u32>;");
        expect(code).toContain("@group(0) @binding(2) var depthTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(3) var blueNoiseTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(4) var<uniform> uniforms:MeshBlendUniforms;");
        expect(code).not.toContain("sampler");
        expect(code).not.toContain("textureSample");
        expect(code).toContain("let packed=textureLoad(tagTexture,cp(pixel,size),0).r");
        expect(code).toContain("let source=textureLoad(sourceTexture,pixel,0)");
        expect(code).toContain("let pixel=clamp(vec2i(floor(input.uv*vec2f(size))),vec2i(0),size-vec2i(1))");
    });

    it("uses Lite's top-left fullscreen UV and flips pixel UV back to NDC Y", () => {
        const code = shader();
        expect(code).toContain("out.uv=vec2f(p.x*0.5+0.5,0.5-p.y*0.5)");
        expect(code).toContain("let ndcXY=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0)");
    });

    it("maps Lite storage coordinates to Babylon.js algorithm coordinates", () => {
        const code = shader();
        expect(code).toContain("fn ap(pixel:vec2i,size:vec2i)->vec2i{return vec2i(pixel.x,size.y-1-pixel.y);}");
        expect(code).toContain("fn po(d:vec2f,x:f32)->vec2i{return vec2i(round(vec2f(d.x,-d.y)*x));}");
        expect(code).toContain("let noisePixel=ap(pixel,renderSize)");
        expect(code).toContain("let random=ln(pixel,size)");
        expect(code).toContain("let sampled=lt(pixel+po(d,x),size)");
        expect(code).toContain("let oppositePixel=cp(pixel-po(result.k.d,1.0),size)");
    });

    it("does not declare identifiers reserved by WGSL", () => {
        for (const quality of [MeshBlendQuality.Low, MeshBlendQuality.Medium, MeshBlendQuality.High, MeshBlendQuality.Cinematic]) {
            const code = shader(quality);
            expect(code).not.toMatch(/\btarget\s*[:=]/);
        }
    });

    it("specializes view and screen depth reconstruction", () => {
        const viewDepth = shader(MeshBlendQuality.Medium, MeshBlendDepthType.View);
        const screenDepth = shader(MeshBlendQuality.Medium, MeshBlendDepthType.Screen);

        expect(viewDepth).toContain("const DEPTH_TYPE:i32=0;");
        expect(screenDepth).toContain("const DEPTH_TYPE:i32=1;");
        for (const code of [viewDepth, screenDepth]) {
            expect(code).toContain("if(DEPTH_TYPE==1){return depth;}");
            expect(code).toContain("let clip=uniforms.projection*vec4f(0,0,depth,1);return clip.z/clip.w;");
            expect(code).toContain("uniforms.inverseProjection*vec4f(ndcXY,dn(depth),1)");
        }
    });
});

describe("mesh-blending WGSL quality variants", () => {
    const cases = [
        [MeshBlendQuality.Low, 3, 2, 1, 2, 5, "0.5", false, "0.5", false, false, false, "sRGB"],
        [MeshBlendQuality.Medium, 3, 3, 2, 4, 8, "0.9", false, "0.5", false, false, false, "OKLab"],
        [MeshBlendQuality.High, 3, 3, 3, 5, 10, "1", true, "0.5", true, true, true, "OKLab"],
        [MeshBlendQuality.Cinematic, 8, 6, 4, 5, 50, "0.95", true, "1", true, true, true, "OKLab"],
    ] as const;

    it.each(cases)(
        "emits exact constants and features for quality %i",
        (
            quality,
            directions,
            radialSamples,
            refinementSamples,
            refinementSteps,
            exactEdgeSamples,
            radiusScale,
            fullRotation,
            jitter,
            fallback,
            tinyObject,
            secondary,
            interpolation
        ) => {
            const code = shader(quality as MeshBlendQuality);
            expect(code).toContain(`const DIRECTION_COUNT:i32=${directions};`);
            expect(code).toContain(`const RADIAL_SAMPLE_COUNT:i32=${radialSamples};`);
            expect(code).toContain(`const REFINEMENT_SAMPLE_COUNT:i32=${refinementSamples};`);
            expect(code).toContain(`const REFINEMENT_STEP_COUNT:i32=${refinementSteps};`);
            expect(code).toContain(`const EXACT_EDGE_SAMPLE_COUNT:i32=${exactEdgeSamples};`);
            expect(code).toContain(`const RADIUS_SCALE:f32=${radiusScale};`);
            expect(code).toContain(`const FULL_RANDOM_ROTATION:bool=${fullRotation};`);
            expect(code).toContain(`const JITTER_FACTOR:f32=${jitter};`);
            expect(code).toContain(`const FOUR_NEIGHBOR_FALLBACK:bool=${fallback};`);
            expect(code).toContain(`const TINY_OBJECT_SAFEGUARD:bool=${tinyObject};`);
            expect(code).toContain(`const MULTI_TARGET_SECONDARY_BLEND:bool=${secondary};`);

            if (interpolation === "sRGB") {
                expect(code).toContain("return G(mix(L(current),L(t),amount));");
                expect(code).not.toContain("fn lo");
            } else {
                expect(code).toContain("fn lo");
                expect(code).toContain("fn ol");
            }
        }
    );

    it("emits secondary-target evaluation only for High and Cinematic", () => {
        for (const quality of [MeshBlendQuality.Low, MeshBlendQuality.Medium]) {
            const code = shader(quality);
            expect(code).toContain("let secondary=ir();");
            expect(code).not.toContain("let secondaryColor=ec");
        }
        for (const quality of [MeshBlendQuality.High, MeshBlendQuality.Cinematic]) {
            const code = shader(quality);
            expect(code).toContain("var secondary=ir();");
            expect(code).toContain("let secondaryColor=ec");
            expect(code).toContain("if(combined<=EPSILON){return source;}");
        }
    });
});

describe("mesh-blending WGSL optional shadow path", () => {
    it("removes every base-color binding, field, load, and shadow calculation when absent", () => {
        const code = shader(MeshBlendQuality.High, MeshBlendDepthType.View, MeshBlendDebugMode.ShadowAttenuation, false);
        expect(code).not.toContain("baseColorTexture");
        expect(code).not.toContain("fartherBaseColor");
        expect(code).not.toContain("conservativeNearBaseColor");
        expect(code).not.toContain("estimateShadow");
        expect(code).not.toContain("SHADOW_DIFFERENCE_LOW");
        expect(code).toContain("@group(0) @binding(3) var blueNoiseTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(4) var<uniform> uniforms:MeshBlendUniforms;");
        expect(code).toContain("evaluation.sa=1.0;");
    });

    it("adds the exact shifted bindings, base-color texel loads, and attenuation constants when present", () => {
        const code = shader(MeshBlendQuality.High, MeshBlendDepthType.View, MeshBlendDebugMode.ShadowAttenuation, true);
        expect(code).toContain("@group(0) @binding(3) var baseColorTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(4) var blueNoiseTexture:texture_2d<f32>;");
        expect(code).toContain("@group(0) @binding(5) var<uniform> uniforms:MeshBlendUniforms;");
        expect(code).toContain("d:vec3f,e:vec3f,");
        expect(code).toContain("textureLoad(baseColorTexture,result.f,0).rgb");
        expect(code).toContain("const SHADOW_DIFFERENCE_LOW:f32=0.15;");
        expect(code).toContain("const SHADOW_DIFFERENCE_HIGH:f32=0.5;");
        expect(code).toContain("const SHADOW_MIN_ATTENUATION:f32=0.25;");
        expect(code).toContain("evaluation.sa=sa(evaluation.c.rgb,evaluation.s);");
    });
});

describe("mesh-blending WGSL math, debug, and output contracts", () => {
    it("emits the exact radius, contact, fade, and OKLab constants", () => {
        const code = shader(MeshBlendQuality.High);
        for (const constant of [
            "const TWO_PI:f32=6.283185307179586;",
            "const EPSILON:f32=0.00001;",
            "const REFINEMENT_SECTOR_SCALE:f32=0.2;",
            "const MIN_SLOPE_SCALE:f32=0.25;",
            "const BOUNDARY_SEPARATION_FACTOR:f32=0.75;",
            "const BOUNDARY_PIXEL_TOLERANCE:f32=3.0;",
            "const FOREGROUND_DEPTH_FACTOR:f32=0.35;",
            "const FOREGROUND_LATERAL_FACTOR:f32=2.0;",
            "const TARGET_SPAN_FACTOR:f32=1.5;",
            "const TOTAL_SPAN_FACTOR:f32=2.5;",
            "const NEAR_EDGE_TARGET_WEIGHT:f32=0.35;",
            "const NEAR_SEAM_MAX_DISTANCE:f32=1.25;",
            "const NEAR_SEAM_COLOR_DELTA:f32=0.02;",
        ]) {
            expect(code).toContain(constant);
        }
        expect(code).toContain("0.4122214708*color.r+0.5363325363*color.g+0.0514459929*color.b");
        expect(code).toContain("4.0767416621*l-3.3077115913*m+0.2309699292*s");
        expect(code).toContain(
            "fn cf(x:f32,radius:f32)->f32{let normalized=clamp(max(x-0.5,0.0)/max(radius,EPSILON),0.0,1.0);let inverse=1.0-normalized;return mix(inverse*inverse,inverse,clamp(inverse-0.75,0.0,1.0))*0.5;}"
        );
    });

    it.each(Object.values(MeshBlendDebugMode).filter((value): value is MeshBlendDebugMode => typeof value === "number"))("generates debug variant %i", (debugMode) => {
        expect(shader(MeshBlendQuality.High, MeshBlendDepthType.View, debugMode)).toContain(`const DEBUG_MODE:i32=${debugMode};`);
    });

    it("contains every debug-mode output contract and specializes WorldPosition", () => {
        const code = shader(MeshBlendQuality.High, MeshBlendDepthType.View, MeshBlendDebugMode.WorldPosition);
        for (const marker of [
            "if(DEBUG_MODE==1)",
            "if(DEBUG_MODE==2)",
            "if(DEBUG_MODE==3)",
            "if(DEBUG_MODE==4)",
            "if(DEBUG_MODE==5)",
            "if(DEBUG_MODE==6)",
            "if(DEBUG_MODE==7)",
            "if(DEBUG_MODE==8)",
            "if(DEBUG_MODE==9)",
            "if(DEBUG_MODE==10)",
            "if(DEBUG_MODE==11)",
        ]) {
            expect(code).toContain(marker);
        }
        expect(code).toContain("evaluation.w=(uniforms.inverseView*vec4f(result.p,1)).xyz;");
        expect(code).toContain("return vec4f(fract(primaryColor.w*0.1),1);");
        expect(shader()).not.toContain("primaryColor.w");
    });

    it("preserves exact source texels for disabled and rejected non-debug paths", () => {
        const code = shader();
        expect(code).toContain("let source=textureLoad(sourceTexture,pixel,0);");
        expect(code).toContain("if(uniforms.flags.z<0.5){return source;}");
        expect(code).toContain("return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);");
        expect(code).toContain("return primaryColor.b;");
    });

    it("does not clamp HDR or negative SceneColor during either interpolation path", () => {
        for (const quality of [MeshBlendQuality.Low, MeshBlendQuality.High]) {
            const code = shader(quality);
            const interpolation = code.slice(code.indexOf("fn ci"), code.indexOf("fn lm"));
            expect(interpolation).not.toContain("clamp");
            expect(interpolation).not.toContain("saturate");
            expect(code).toContain("evaluation.b=vec4f(ci(evaluation.c.rgb,evaluation.s.t.rgb,evaluation.f),mix(evaluation.c.a,evaluation.s.t.a,evaluation.f));");
        }
    });
});
