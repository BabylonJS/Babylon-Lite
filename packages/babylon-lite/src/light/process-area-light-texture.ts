import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { TU } from "../engine/gpu-flags.js";
import { createEffectWrapper, disposeEffectWrapper, recordEffectToTexture, setEffectTexture } from "../effect/effect-renderer.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { _isTextureReleased } from "../resource/texture-owner-state.js";
import { getOrCreateSampler, getTextureSamplerDescriptor } from "../resource/texture-sampler-pool.js";
import { generateMipmaps } from "../texture/generate-mipmaps.js";
import { readTexturePixels } from "../texture/read-texture-pixels.js";
import { validateAreaLightSource } from "./area-light-image.js";
import { blurAreaLightPixels } from "./area-light-blur.js";
import { wgsl } from "../shader/wgsl.js";
import { _installRectAreaEmission } from "./enable-rect-area-lights.js";
import type { SceneContext } from "../scene/scene.js";
import type { SceneLightingExtension } from "./lighting-extension.js";
import type { RectAreaLight } from "./rect-area-light.js";
import type * as EmissionSetup from "./area-light-emission-setup.js";
import { MAX_LIGHTS } from "./types.js";

let emissionSetup: typeof EmissionSetup | undefined;
/** @internal A scene dispatch owns no source allocation or preprocessing promise. */
export async function prepareEmissionLighting(scene: SceneContext, lighting: SceneLightingExtension): Promise<void> {
    let packed = 0;
    const textured = scene.lights.some(
        (light) => light._writeLightUbo && packed++ < MAX_LIGHTS && light.lightType === "rectArea" && (light as RectAreaLight).emissionTexture !== null
    );
    if (textured) {
        emissionSetup = await import("./area-light-emission-setup.js");
        await emissionSetup.prepareRectAreaEmission(scene, lighting);
    } else {
        emissionSetup?.clearAreaLightEmission(scene);
    }
}

/** Preprocess an ordinary color texture for RectAreaLight emission. The caller owns the returned texture. */
export async function processAreaLightTexture(engine: EngineContext, source: Texture2D): Promise<Texture2D> {
    validateAreaLightSource(source);
    const device = engine._device;
    const input = { ...source };
    const current = (): void => {
        if (engine._device !== device) {
            throw new Error("RectAreaLight: device changed during emission preprocessing");
        }
        if (source.texture !== input.texture) {
            throw new Error("RectAreaLight: source allocation changed during emission preprocessing");
        }
        if (_isTextureReleased(input)) {
            throw new Error("RectAreaLight: source was released during emission preprocessing");
        }
    };
    let texture: GPUTexture | undefined;
    let effect: ReturnType<typeof createEffectWrapper> | undefined;
    let scoped = false;
    try {
        device.pushErrorScope("validation");
        scoped = true;
        texture = device.createTexture({
            label: "rect-area-emission",
            size: [1024, 1024],
            format: "rgba8unorm",
            mipLevelCount: 11,
            usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_SRC | TU.COPY_DST,
        });
        effect = createEffectWrapper(engine, {
            name: "rect-area-emission-scale",
            vertexWGSL: wgsl`
struct EffectVertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn effectFullscreenVertex(@builtin(vertex_index) index: u32) -> EffectVertexOutput {
let p = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0))[index];
return EffectVertexOutput(vec4<f32>(p,0.0,1.0),p*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5));
}`,
            bindings: [
                { binding: 0, kind: "texture" },
                { binding: 1, kind: "sampler", textureBinding: 0 },
            ],
            fragmentWGSL: wgsl`
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@fragment fn effectFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
let sourceUV = vec2<f32>(uv.x, ${source.invertY ? "1.0 - uv.y" : "uv.y"});
return textureSample(image,imageSampler,(sourceUV - vec2<f32>(0.125))/0.75);
}`,
        });
        const sampling = getTextureSamplerDescriptor(engine, source.sampler) ?? { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" };
        const sampler = getOrCreateSampler(engine, { ...sampling, addressModeU: "mirror-repeat", addressModeV: "mirror-repeat" });
        setEffectTexture(effect, 0, { ...source, sampler });
        const encoder = device.createCommandEncoder();
        recordEffectToTexture(effect, encoder, texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), "rgba8unorm");
        device.queue.submit([encoder.finish()]);
        const validation = device.popErrorScope();
        scoped = false;
        const error = await validation;
        if (error) {
            throw new Error(`RectAreaLight: emission scale/device validation failed: ${error.message}`);
        }
        current();
        const scaled = await readTexturePixels(device, texture);
        current();
        const blurred = blurAreaLightPixels(scaled);
        device.pushErrorScope("validation");
        scoped = true;
        device.queue.writeTexture({ texture }, blurred, { bytesPerRow: 4096, rowsPerImage: 1024 }, [1024, 1024]);
        generateMipmaps(engine, texture);
        const uploadValidation = device.popErrorScope();
        scoped = false;
        const uploadError = await uploadValidation;
        if (uploadError) {
            throw new Error(`RectAreaLight: emission upload failed: ${uploadError.message}`);
        }
        current();
        const result: Texture2D = {
            texture,
            view: texture.createView(),
            sampler: getOrCreateSampler(engine, { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }),
            width: 1024,
            height: 1024,
            _areaLightImage: { device, texture },
        };
        acquireTexture(result);
        _installRectAreaEmission(prepareEmissionLighting);
        texture = undefined;
        return result;
    } finally {
        if (scoped) {
            void device.popErrorScope().catch(() => {});
        }
        if (effect) {
            disposeEffectWrapper(effect);
        }
        texture?.destroy();
    }
}
