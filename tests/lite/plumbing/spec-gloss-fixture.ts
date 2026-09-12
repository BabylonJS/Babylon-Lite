import { assembleMaterial } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material";
import { loadVariantMaterials } from "../../../packages/babylon-lite/src/loader-gltf/gltf-variants";
import { runGltfMaterialFeatures } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-registry";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import specGloss from "../../../packages/babylon-lite/src/loader-gltf/gltf-ext-spec-gloss";
import uvTransform from "../../../packages/babylon-lite/src/loader-gltf/gltf-ext-uv-transform";
import { assemblePbrProps, applyGltfOptInPbrFeatures, buildDefaultPbrTextures } from "../../../packages/babylon-lite/src/loader-gltf/gltf-pbr-builder";
import { assemblePbrPropsExt, applyGltfUvTransform } from "../../../packages/babylon-lite/src/loader-gltf/gltf-pbr-builder-ext";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { createPbrTemplateExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-template-ext";
import { _computePbrMaterialFeatures } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { _writeMaterialData } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { MSH_HAS_UV2, MSH_HAS_VERTEX_COLOR } from "../../../packages/babylon-lite/src/material/mesh-features";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { setPbrMetallicReflectance } from "../../../packages/babylon-lite/src/material/pbr/set-metallic-reflectance";
import { registerPbrPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-bridge";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _registerPbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";

// Observe production BRDF locals through a typed fragment and storage binding.
// BC runs after MF contributions; alpha-test discard has already happened.
const probeExt: PbrExt = {
    id: "test-brdf-observer",
    phase: "fragment",
    frag: () => ({
        _id: "test-brdf-observer",
        _bindings: [{ _name: "brdfProbe", _type: { _kind: "storage-texture", _access: "write", _format: "rgba32float" }, _visibility: 2 }],
        _fragmentSlots: {
            BC: wgsl`
textureStore(brdfProbe,vec2i(0,0),vec4f(baseColor,alpha*material.materialAlpha));
textureStore(brdfProbe,vec2i(1,0),vec4f(colorF0,1.0-roughness));
textureStore(brdfProbe,vec2i(2,0),vec4f(surfaceAlbedo,roughness));
textureStore(brdfProbe,vec2i(3,0),vec4f(occlusion,colorF90));`,
        },
    }),
};

export interface SgCase {
    name: string;
    diffuseFactor?: number[];
    specularFactor?: number[];
    glossinessFactor?: number;
    diffuse?: boolean;
    specular?: boolean;
    alphaMode?: string;
    vertexColor?: boolean;
    transformed?: boolean;
    uv1?: boolean;
    fallback?: boolean;
    mr?: boolean;
    variant?: boolean;
    legacy?: boolean;
    animatedOcclusion?: boolean;
    plugin?: boolean;
    reflectanceUv?: boolean;
}

// Owned synthetic texels, not external assets. RGB uses the hardware sRGB decode;
// alpha stays linear. Distinct texels make a wrong UV set/transform observable.
const diffuseBytes = [128, 64, 192, 128];
const specularBytes = [64, 128, 192, 128];

export async function runSgCase(device: GPUDevice, c: SgCase) {
    const owned: (GPUTexture | GPUBuffer)[] = [];
    const engine = { _device: device } as EngineContext;
    const sampler = device.createSampler({ addressModeU: "repeat" });
    const makeTexture = (bytes: number[], srgb: boolean): Texture2D => {
        const t = device.createTexture({ size: [2, 1], format: srgb ? "rgba8unorm-srgb" : "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        owned.push(t);
        device.queue.writeTexture({ texture: t }, new Uint8Array([...bytes, 255, 255, 255, 255]), { bytesPerRow: 8 }, [2, 1]);
        return { texture: t, view: t.createView(), sampler, width: 2, height: 1 };
    };
    const buffer = (data: Float32Array, usage = GPUBufferUsage.UNIFORM) => {
        const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        owned.push(b);
        device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
        return b;
    };
    try {
        const info = (index: number) =>
            c.transformed ? { index, texCoord: 0, extensions: { KHR_texture_transform: { texCoord: 1, offset: [-0.5, 0] } } } : c.uv1 ? { index, texCoord: 1 } : { index };
        const sg = {
            diffuseFactor: c.diffuseFactor,
            specularFactor: c.specularFactor,
            glossinessFactor: c.glossinessFactor,
            diffuseTexture: c.diffuse ? info(0) : undefined,
            specularGlossinessTexture: c.specular ? info(1) : undefined,
        };
        const raw = {
            alphaMode: c.alphaMode ?? "OPAQUE",
            alphaCutoff: 0.3,
            doubleSided: true,
            pbrMetallicRoughness: c.fallback || c.mr ? { baseColorFactor: [0.7, 0.2, 0.4, 0.6], metallicFactor: 0.4, roughnessFactor: 0.8 } : undefined,
            extensions: c.mr ? undefined : { KHR_materials_pbrSpecularGlossiness: sg },
        };
        const mat = await assembleMaterial({ materials: [raw] }, new DataView(new ArrayBuffer(0)), 0, "", []);
        const ext = await specGloss.applyMaterial!(mat, {
            _engine: engine,
            _texture(ti, srgb) {
                if (!ti) {
                    return Promise.resolve(undefined);
                }
                const t = makeTexture((ti as { index: number }).index === 0 ? diffuseBytes : specularBytes, srgb);
                return Promise.resolve(c.transformed ? uvTransform.wrapTexture!(t, ti) : t);
            },
            _uploadImage() {
                throw new Error("Unexpected image synthesis");
            },
        });
        const textures = buildDefaultPbrTextures(
            engine,
            mat,
            sampler,
            () => {},
            () => {
                throw new Error("Unexpected fallback image");
            }
        );
        owned.push(textures.baseColorTexture.texture, textures.ormTexture.texture);
        let props =
            c.transformed || c.uv1
                ? assemblePbrPropsExt(mat, { ...textures, occlusionTexture: undefined }, ext ?? undefined)
                : assemblePbrProps(mat, textures.baseColorTexture, textures.ormTexture, textures.normalTexture, textures.emissiveTexture, ext ?? undefined);
        if (c.transformed) {
            await applyGltfUvTransform(props, { ...textures, occlusionTexture: undefined });
        }
        await applyGltfOptInPbrFeatures(props, mat);
        if (c.legacy) {
            // Public texture-only materials have no glTF factor tuple.
            delete props._specularGlossiness;
        }
        if (c.animatedOcclusion) {
            setPbrMetallicReflectance(props, {});
            (props as PbrMaterialProps & { _occlStrengthAnimated: boolean })._occlStrengthAnimated = true;
            props.occlusionStrength = 0.4;
            props.ormTexture = makeTexture([64, 255, 255, 255], false);
        }
        if (c.reflectanceUv) {
            const texture = uvTransform.wrapTexture!(makeTexture([90, 140, 200, 255], true), {
                index: 0,
                extensions: { KHR_texture_transform: { offset: [0.1, 0] } },
            });
            setPbrMetallicReflectance(props, { reflectanceTexture: texture, specularWeight: 0.3 });
        }
        if (c.plugin) {
            registerPbrPlugins(_registerPbrExt);
            props.plugins = [{ name: "SG F0 modifier", getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_LIGHTS: "colorF0 *= 0.5;" }) }];
        }
        if (c.variant) {
            const json = {
                materials: [raw],
                nodes: [{ mesh: 0 }],
                meshes: [{ primitives: [{ extensions: { KHR_materials_variants: { mappings: [{ material: 0, variants: [0] }] } } }] }],
            };
            const variants = await loadVariantMaterials(json, new DataView(new ArrayBuffer(0)), "", ["SG"], [{} as Mesh], engine, [specGloss], runGltfMaterialFeatures);
            props = variants.variants.SG![0]!.material as PbrMaterialProps;
            owned.push(props.baseColorTexture!.texture, props.ormTexture!.texture);
        }
        _registerPbrExt(probeExt);
        const flags = _computePbrMaterialFeatures(props);
        const compose = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: createPbrTemplateExt,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        const code = compose(
            flags.features,
            flags.features2,
            (c.vertexColor ? MSH_HAS_VERTEX_COLOR : 0) | (c.transformed || c.uv1 ? MSH_HAS_UV2 : 0),
            0,
            0,
            "point",
            "",
            undefined,
            "",
            props._uv2Mask,
            props._pi
        );
        const sceneLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 3, buffer: { type: "uniform" } }] });
        // The composer stores WGSL access names; the test-owned storage binding
        // supplies the corresponding WebGPU descriptor without reading shader text.
        const meshLayout = device.createBindGroupLayout({
            entries: Array.from(code._meshBGLDescriptor.entries, (entry) =>
                entry.storageTexture ? { ...entry, storageTexture: { ...entry.storageTexture, access: "write-only" } } : entry
            ),
        });
        const pipeline = await device.createRenderPipelineAsync({
            layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, meshLayout] }),
            vertex: { module: device.createShaderModule({ code: code._vertexWGSL }), buffers: code._vertexBufferLayouts },
            fragment: { module: device.createShaderModule({ code: code._fragmentWGSL }), targets: [{ format: "rgba32float" }] },
            primitive: { topology: "triangle-list" },
        });
        const ubo = new Float32Array(code._materialUboSpec!._totalBytes / 4);
        _writeMaterialData(ubo, props, code._materialUboSpec!);
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const mesh = new Float32Array(code._meshUboSpec._totalBytes / 4);
        mesh.set(identity, code._meshUboSpec._offsets.get("world")! / 4);
        const output = device.createTexture({ size: [4, 1], format: "rgba32float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
        owned.push(output);
        device.queue.writeTexture({ texture: output }, new Float32Array(16).fill(-1), { bytesPerRow: 64 }, [4, 1]);
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: buffer(mesh) } },
            { binding: 1, resource: { buffer: buffer(ubo) } },
        ];
        // The fixture enables only these base textures, in the documented PBR binding order.
        const texturesInOrder = [
            props.baseColorTexture!,
            props.ormTexture!,
            ...(props.specGlossTexture ? [props.specGlossTexture] : []),
            ...(props._reflectanceTexture ? [props._reflectanceTexture] : []),
        ];
        let textureIndex = 0;
        let samplerIndex = 0;
        for (const layout of code._meshBGLDescriptor.entries) {
            if (layout.texture) {
                entries.push({ binding: layout.binding, resource: texturesInOrder[textureIndex++]!.view });
            } else if (layout.sampler) {
                entries.push({ binding: layout.binding, resource: texturesInOrder[samplerIndex++]!.sampler });
            } else if (layout.storageTexture) {
                entries.push({ binding: layout.binding, resource: output.createView() });
            }
        }
        const scene = new Float32Array(128);
        scene.set(identity);
        scene.set(identity, 16);
        scene[34] = 1;
        const sceneGroup = device.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: buffer(scene) } }] });
        const group = device.createBindGroup({ layout: meshLayout, entries });
        const vertexData = [
            [-1, -1, 0.5, 3, -1, 0.5, -1, 3, 0.5],
            [0, 0, 1, 0, 0, 1, 0, 0, 1],
            Array.from({ length: 3 }, () => [c.uv1 ? 0.75 : 0.25, 0.5]).flat(),
            ...(c.transformed || c.uv1 ? [Array.from({ length: 3 }, () => [c.transformed ? 0.75 : 0.25, 0.5]).flat()] : []),
            ...(c.vertexColor ? [Array.from({ length: 3 }, () => [0.5, 0.25, 0.75, 0.5]).flat()] : []),
        ];
        const vertexBuffers = vertexData.map((data) => buffer(new Float32Array(data), GPUBufferUsage.VERTEX));
        const target = device.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        owned.push(target);
        const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        owned.push(readback);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, sceneGroup);
        pass.setBindGroup(1, group);
        vertexBuffers.forEach((value, index) => pass.setVertexBuffer(index, value));
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [4, 1]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const data = readback.getMappedRange();
        const values = [0, 16, 32, 48].map((offset) => Array.from(new Float32Array(data.slice(offset, offset + 16))));
        readback.unmap();
        return { values, uboBytes: ubo.byteLength, bindings: entries.length };
    } finally {
        for (const item of owned) {
            item.destroy();
        }
    }
}
