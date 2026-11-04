import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { createOpacityMaskPixels, MASK_HEIGHT, MASK_WIDTH, OPACITY_COLUMNS, OPACITY_ROWS, SHADOW_SAMPLES, waitOpacityFrames } from "../shared/scene348-opacity.js";

interface PipelineInternals {
    _alphaToCoverageEnabled: boolean;
    _buildRenderPipelineDescriptor(effect: Effect, topology: GPUPrimitiveTopology, sampleCount: number): GPURenderPipelineDescriptor;
    setAlphaToCoverage(enabled: boolean): void;
}

/** Reference-only A2C normalization, following scene274 for the pinned Babylon.js pipeline cache. */
function installReferenceAlphaToCoverage(): void {
    const prototype = WebGPUCacheRenderPipeline.prototype as unknown as PipelineInternals;
    const build = prototype._buildRenderPipelineDescriptor;
    prototype._buildRenderPipelineDescriptor = function (effect, topology, sampleCount) {
        const descriptor = build.call(this, effect, topology, sampleCount);
        descriptor.multisample!.alphaToCoverageEnabled = this._alphaToCoverageEnabled && sampleCount > 1;
        return descriptor;
    };
}

async function main(): Promise<void> {
    // ?baseline makes all colour factors 1 for the before-change state comparison, not the golden.
    const baseline = new URLSearchParams(location.search).has("baseline");
    const factor = (value: number): number => (baseline ? 1 : value);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    installReferenceAlphaToCoverage();
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, premultipliedAlpha: false });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.08, 0.1, 0.14, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, 1.2, 17, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.65;
    hemi.specular = Color3.Black();
    const light = new DirectionalLight("directional", new Vector3(0.4, -1, 0.7), scene);
    light.position.set(-4, 10, -7);
    light.intensity = 0.8;
    light.specular = Color3.Black();
    light.shadowMinZ = 0.1;
    light.shadowMaxZ = 40;
    const shadows = new ShadowGenerator(1024, light);
    shadows.usePercentageCloserFiltering = true;
    shadows.bias = 0.00005;

    const mask = RawTexture.CreateRGBATexture(createOpacityMaskPixels(), MASK_WIDTH, MASK_HEIGHT, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    mask.hasAlpha = true;
    mask.gammaSpace = false;
    mask.wrapU = mask.wrapV = Texture.CLAMP_ADDRESSMODE;
    const shared = new Map<string, Material>();

    for (const row of OPACITY_ROWS) {
        let material: StandardMaterial | PBRMaterial;
        if (row.family === "standard") {
            material = new StandardMaterial(row.name, scene);
            material.diffuseColor = Color3.FromArray(row.color);
            material.specularColor = Color3.Black();
        } else {
            material = new PBRMaterial(row.name, scene);
            material.albedoColor = Color3.FromArray(row.color);
            material.metallic = 0;
            material.roughness = 0.82;
            if (row.name === "normalized-opaque") {
                material.transparencyMode = Material.MATERIAL_OPAQUE;
            } else if (row.name === "normalized-mask") {
                material.albedoTexture = mask;
                material.useAlphaFromAlbedoTexture = true;
                material.alphaCutOff = 0.5;
                material.transparencyMode = Material.MATERIAL_ALPHATEST;
            }
        }
        shared.set(row.name, material);

        for (const column of OPACITY_COLUMNS) {
            const mesh = MeshBuilder.CreatePlane(`${row.name}-${column.opacity}-${column.x}`, { width: 2.2, height: 1.3 }, scene);
            mesh.position.set(column.x, row.y, 0);
            mesh.visibility = factor(column.opacity);
            mesh.material = material;

            // Region (a): DIRECT BJS visibility parity, without explicit transparency modes.
            // Region (b): NORMALIZED Lite glTF policy, NOT raw BJS visibility parity.
            // Only BJS clones the faded material. Twins retain the original explicit mode;
            // Lite must use one shared material per row, unchanged.
            if (!baseline && column.opacity < 1 && material instanceof PBRMaterial && row.name.startsWith("normalized-")) {
                const normalized = material.clone(`${mesh.name}-oracle`);
                normalized.transparencyMode = row.name === "normalized-mask" ? Material.MATERIAL_ALPHATESTANDBLEND : Material.MATERIAL_ALPHABLEND;
                normalized.useRadianceOverAlpha = false;
                normalized.useSpecularOverAlpha = false;
                mesh.material = normalized;
                // MASK: discard uses a_orig at cutoff 0.5; late visibility gives a_out = a_orig * v.
                // Bands 128..224 must survive even though their faded alpha is below the cutoff.
            }
        }
    }

    const ground = MeshBuilder.CreateGround("policy-shadow-receiver", { width: 14, height: 7 }, scene);
    ground.position.set(0, -4.2, 1.5);
    const groundMaterial = new StandardMaterial("ground", scene);
    groundMaterial.diffuseColor = new Color3(0.55, 0.58, 0.62);
    groundMaterial.specularColor = Color3.Black();
    ground.material = groundMaterial;
    ground.receiveShadows = true;

    for (const sample of SHADOW_SAMPLES) {
        const mesh = MeshBuilder.CreateBox(sample.name, { size: 1.1 }, scene);
        mesh.position.set(sample.x, -3.55, 0);
        mesh.material = shared.get(sample.family === "standard" ? "direct-standard" : "direct-pbr")!;
        mesh.visibility = factor(sample.opacity);

        // Lite policy, normalized: separate full-strength shadow-only geometry, never raw BJS
        // fractional/zero visibility shadows. A custom shadow renderList ignores camera layerMask
        // (ObjectRenderer.forceLayerMaskCheck defaults false), while main camera excludes layer 0.
        const caster = MeshBuilder.CreateBox(`${sample.name}-full-shadow-oracle`, { size: 1.1 }, scene);
        caster.position.copyFrom(mesh.position);
        caster.material = mesh.material;
        caster.layerMask = 0;
        shadows.addShadowCaster(caster, false);
    }

    // Lite policy, normalized: preserve A2C AND alpha blend, both driven by final alpha 0.5.
    const a2cMaterial = new StandardMaterial("policy-a2c", scene);
    a2cMaterial.diffuseColor = new Color3(0.7, 0.25, 0.85);
    a2cMaterial.specularColor = Color3.Black();
    const a2c = MeshBuilder.CreatePlane("policy-a2c-half", { width: 1.1, height: 2.4 }, scene);
    a2c.position.set(6.4, 1.1, 0);
    a2c.material = a2cMaterial;
    a2c.visibility = factor(0.5);
    a2c.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false);
    const cache = (engine as unknown as { _cacheRenderPipeline: PipelineInternals })._cacheRenderPipeline;
    let previousA2c = false;
    scene.onBeforeRenderingGroupObservable.add(({ renderingGroupId }) => {
        previousA2c = cache._alphaToCoverageEnabled;
        cache.setAlphaToCoverage(renderingGroupId === 1 && engine.currentSampleCount > 1);
    });
    scene.onAfterRenderingGroupObservable.add(() => cache.setAlphaToCoverage(previousA2c));

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await waitOpacityFrames(12);
    canvas.dataset.opacityMode = baseline ? "baseline-oracle" : "normalized-oracle";
    canvas.dataset.oracleRegions = "direct-standard-pbr,normalized-opaque-mask,normalized-shadow-a2c-policy";
    canvas.dataset.sampleCount = String(engine.currentSampleCount);
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
