/** EXT_lights_image_based glTF extension.
 *
 *  Installs a document-level image-based light (diffuse irradiance SH9 + a set of
 *  prefiltered specular mip cubemaps, plus intensity/rotation) referenced by the
 *  active scene, driving the PBR IBL through Lite's existing environment path.
 *
 *  Reuse (KISS, maximum reuse per GUIDANCE):
 *   - Specular mips are RGBD-encoded PNGs (identical encoding to Babylon `.env`
 *     faces), so they upload through the shared `uploadCubemapRGBD` decoder.
 *   - The BRDF split-sum LUT is generated procedurally on-GPU (`generateBrdfLut`,
 *     shared with the HDR loader) — no external asset URL is needed.
 *   - The final `EnvironmentTextures` are assembled with `assembleEnvironmentTextures`
 *     and wired onto the scene exactly like `loadEnvironment` / `loadHdrEnvironment`
 *     (`scene._envTextures` + `registerEnvSceneUniforms` + tone-mapping defaults).
 *
 *  The glTF `irradianceCoefficients` are raw SH9 coefficients. Babylon converts
 *  them SH → intensity scale → Lambertian radiance (×1/π) → SphericalPolynomial,
 *  and its shader later expands that polynomial to the pre-scaled harmonics the
 *  scene UBO consumes. We reproduce the SH→polynomial step here so the shared
 *  `polynomialToPreScaledHarmonics` (inside `assembleEnvironmentTextures`) yields
 *  byte-for-byte the same rendering coefficients as Babylon.
 */

import type { GltfFeature } from "./gltf-feature.js";
import type { SceneContext } from "../scene/scene-core.js";

// NOTE: this module is a lazily-imported feature chunk (see gltf-feature-registry)
// and keeps ZERO static runtime imports — every dependency is pulled in via dynamic
// import inside applyAsset. Scenes that never trigger EXT_lights_image_based never
// fetch this chunk (or its dependencies) at runtime. The heavy IBL helpers it reuses
// (cubemap upload, env-texture assembly, BRDF LUT, SH conversion, samplers) are kept
// as PRIVATE copies (ibl-cubemap-upload.js + ibl-env-assembly.js) rather than shared
// with loader-env / loader-hdr. This is a deliberate, user-approved exception to the
// max-reuse mandate: those canonical helpers are single-consumer and thus inlined
// into every glTF scene's main chunk; importing them here would make this feature a
// second consumer and force rollup to hoist them into shared chunks that all 44 glTF
// scenes would pay for. The private copies isolate the feature's byte cost to the one
// scene that uses it. See ibl-env-assembly.js for the canonical-source mapping.

interface GltfImageBasedLight {
    name?: string;
    intensity?: number;
    rotation?: [number, number, number, number];
    irradianceCoefficients?: number[][];
    specularImageSize: number;
    specularImages: number[][];
}

/** Convert glTF `EXT_lights_image_based` SH9 irradiance coefficients into the
 *  27-float spherical-polynomial layout `[x,y,z,xx,yy,zz,yz,zx,xy]` that
 *  `assembleEnvironmentTextures` → `polynomialToPreScaledHarmonics` expects.
 *
 *  Mirrors Babylon's chain: `SphericalHarmonics.FromArray(coeffs)` →
 *  `scaleInPlace(intensity)` → `convertIrradianceToLambertianRadiance()` (×1/π) →
 *  `SphericalPolynomial.FromHarmonics()` (`updateFromHarmonics`, which folds a
 *  final ×1/π). All band constants are copied from Babylon `sphericalPolynomial`. */
function irradianceCoefficientsToPolynomial(coeffs: number[][], intensity: number): Float32Array {
    // Harmonic scale = intensity (radiance) × 1/π (Lambertian normalisation).
    const s = intensity / Math.PI;
    const poly = new Float32Array(27);
    for (let c = 0; c < 3; c++) {
        const l00 = coeffs[0]![c]! * s;
        const l1_1 = coeffs[1]![c]! * s;
        const l10 = coeffs[2]![c]! * s;
        const l11 = coeffs[3]![c]! * s;
        const l2_2 = coeffs[4]![c]! * s;
        const l2_1 = coeffs[5]![c]! * s;
        const l20 = coeffs[6]![c]! * s;
        const l21 = coeffs[7]![c]! * s;
        const l22 = coeffs[8]![c]! * s;

        // updateFromHarmonics(), then the trailing ×(1/π).
        const k = 1 / Math.PI;
        poly[0 + c] = -1.02333 * l11 * k; // x
        poly[3 + c] = -1.02333 * l1_1 * k; // y
        poly[6 + c] = 1.02333 * l10 * k; // z
        poly[9 + c] = (0.886277 * l00 - 0.247708 * l20 + 0.429043 * l22) * k; // xx
        poly[12 + c] = (0.886277 * l00 - 0.247708 * l20 - 0.429043 * l22) * k; // yy
        poly[15 + c] = (0.886277 * l00 + 0.495417 * l20) * k; // zz
        poly[18 + c] = -0.858086 * l2_1 * k; // yz
        poly[21 + c] = -0.858086 * l21 * k; // zx
        poly[24 + c] = 0.858086 * l2_2 * k; // xy
    }
    return poly;
}

/** Extract the Y-axis rotation angle (radians) from an image-based-light
 *  quaternion. The extension's rotations are pure Y-yaw; Lite drives environment
 *  yaw through `scene.envRotationY`. Babylon inverts the rotation for its
 *  left-handed target scene, so we negate to match its sampling direction. */
function envYawFromQuaternion(q: [number, number, number, number]): number {
    return -2 * Math.atan2(q[1], q[3]);
}

const feature: GltfFeature = {
    id: "EXT_lights_image_based",
    async applyAsset(_meshes, _root, ctx) {
        const json = ctx._json;
        const lights: GltfImageBasedLight[] | undefined = json.extensions?.EXT_lights_image_based?.lights;
        const sceneDef = json.scenes?.[json.scene ?? 0];
        const lightIdx: number | undefined = sceneDef?.extensions?.EXT_lights_image_based?.light;
        if (!lights?.length || lightIdx === undefined) {
            return {};
        }
        const light = lights[lightIdx];
        if (!light?.specularImages?.length || !light.irradianceCoefficients) {
            return {};
        }

        const engine = ctx._engine;
        const specularImageSize = light.specularImageSize;
        const mipCount = light.specularImages.length;

        // Decode every specular face (flat, mip-major face-minor — the order
        // uploadCubemapRGBD expects; glTF face order +X,-X,+Y,-Y,+Z,-Z matches
        // WebGPU cube layers).
        const flatIndices = light.specularImages.flat();
        const { resolveImage } = await import("./ibl-env-assembly.js");
        const faceImages = await Promise.all(flatIndices.map((imgIdx) => resolveImage(json, ctx._binChunk, imgIdx, ctx._baseUrl)));

        const { uploadCubemapRGBD } = await import("./ibl-cubemap-upload.js");
        const specularCube = uploadCubemapRGBD(engine, faceImages, specularImageSize, mipCount);
        for (const img of faceImages) {
            img.close();
        }

        const { generateBrdfLut } = await import("./ibl-env-assembly.js");
        const brdfLut = generateBrdfLut(engine);

        const intensity = light.intensity ?? 1;
        const irradianceSH = irradianceCoefficientsToPolynomial(light.irradianceCoefficients, intensity);
        // Fit the LOD scale to the available mip count exactly as Babylon does.
        const lodGenerationScale = (mipCount - 1) / Math.log2(specularImageSize);

        const { assembleEnvironmentTextures } = await import("./ibl-env-assembly.js");
        const textures = assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, lodGenerationScale, engine);

        const envRotationY = light.rotation ? envYawFromQuaternion(light.rotation) : 0;

        // Pull the scene-wiring helper in now (still lazy — part of this feature
        // chunk) so the synchronous _sceneSetup closure can use it directly.
        // registerEnvSceneUniforms is a private copy (see ibl-env-assembly) to
        // avoid pinning scene-ubo-extras into every glTF scene.
        const { registerEnvSceneUniforms } = await import("./ibl-env-assembly.js");

        // Defer the scene wiring: applyAsset has no SceneContext, so hand the core
        // loader a closure that addToScene() runs against the real scene.
        const _sceneSetup = (scene: SceneContext): void => {
            scene._envTextures = textures;
            if (envRotationY) {
                scene.envRotationY = envRotationY;
            }
            registerEnvSceneUniforms(scene);

            // specularCube + brdfLut are created fresh here and owned solely by
            // this scene (nothing else acquires them), so a direct destroy on
            // scene teardown is equivalent to the gpu-pool refcount path used by
            // load-env — and it avoids pinning gpu-pool's exports into every
            // glTF scene's main chunk, keeping the 43 non-IBL scenes at baseline.
            scene._disposables.push(() => {
                specularCube.destroy();
                brdfLut.destroy();
            });

            // Match loadEnvironment's image-processing defaults (tone mapping on,
            // exposure 0.8, contrast 1.2) so IBL-lit output matches Babylon.
            scene.imageProcessing.toneMappingEnabled = true;
            scene.imageProcessing.exposure = 0.8;
            scene.imageProcessing.contrast = 1.2;
        };

        return { _sceneSetup };
    },
};
export default feature;
