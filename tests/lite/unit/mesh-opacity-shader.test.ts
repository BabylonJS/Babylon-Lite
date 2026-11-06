import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances, setThinInstanceColors } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import { enableMirroredMeshes } from "../../../packages/babylon-lite/src/mesh/enable-mirrored-meshes";
import type { DrawBinding } from "../../../packages/babylon-lite/src/render/renderable";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { createSolidTexture2D } from "../../../packages/babylon-lite/src/texture/solid-texture";
import { BU } from "../../../packages/babylon-lite/src/engine/gpu-flags";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { addClusteredLightContainer, createClusteredLightContainer } from "../../../packages/babylon-lite/src/light/clustered";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { setMeshOpacity } from "../../../packages/babylon-lite/src/mesh/opacity/mesh-opacity";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { setStandardParallaxOcclusion } from "../../../packages/babylon-lite/src/material/standard/set-std-parallax-occlusion";
import { stdParallaxOcclusionExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-parallax-occlusion-fragment";
import { _getStdExtsSorted, _registerStdExt, MATERIAL_ALPHA_BLEND, STD_SCENE_FOG } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import {
    clearStandardPipelineCache,
    _installStdVertexColorFragment,
    composeStandardShader,
    getOrCreateStandardBindings,
    getOrCreateStandardPipeline,
} from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { buildStandardGeometryRenderable } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable";
import { createStandardGeometryMaterialView, preloadStandardGeometryFeatures } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import { createStandardNoColorMaterialView } from "../../../packages/babylon-lite/src/material/standard/no-color-view";
import { createStandardEsmShadowMaterialView } from "../../../packages/babylon-lite/src/material/standard/esm-shadow-view";
import { createStandardFogFragment } from "../../../packages/babylon-lite/src/material/standard/std-fog-wgsl";
import { createStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment";
import { createStandardShadowContext } from "../../../packages/babylon-lite/src/material/standard/fragments/std-shadow-fragment";
import { stdUvTransformExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-uv-transform-fragment";
import { setStandardLightmapTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-lightmap";
import { createThinInstanceFragment } from "../../../packages/babylon-lite/src/shader/fragments/thin-instance-fragment";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import { createPbrGeometryMaterialView, isPbrForwardBuildCurrent } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { createPbrNoColorMaterialView } from "../../../packages/babylon-lite/src/material/pbr/no-color-view";
import { createPbrEsmShadowMaterialView } from "../../../packages/babylon-lite/src/material/pbr/esm-shadow-view";
import { composePbrGeometryShader } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader";
import { clearPbrPipelineCache, getOrCreatePbrBindings, getOrCreatePbrPipeline } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { _registerPbrExt, PBR_HAS_ALPHA_BLEND, PBR_HAS_ENV } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _computeMeshFeatures } from "../../../packages/babylon-lite/src/material/mesh-features";
import { makeRefractionRttExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/refraction-rtt-fragment";
import { pbrExt as iblExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { pbrExt as vatExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/vat-fragment";
import { setPbrAlphaCutoff } from "../../../packages/babylon-lite/src/material/pbr/set-alpha-cutoff";
import { setPbrUnlit } from "../../../packages/babylon-lite/src/material/pbr/set-unlit";
import { setShadowOnly } from "../../../packages/babylon-lite/src/material/pbr/set-shadow-only";
import { setAlphaToCoverage } from "../../../packages/babylon-lite/src/render/alpha-to-coverage";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { makeParallaxTexture } from "./parallax-occlusion-fixtures";

const signature: RenderTargetSignature = { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 4 };
const compact = (source: string): string => source.replace(/\s+/g, "");

function fixture() {
    const contents = new Map<GPUBuffer, Uint8Array>();
    const device = {
        createBindGroupLayout: vi.fn((descriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor) => descriptor),
        createBindGroup: vi.fn((descriptor) => descriptor),
        createShaderModule: vi.fn((descriptor) => descriptor),
        createRenderPipeline: vi.fn((descriptor) => descriptor),
        createSampler: vi.fn((descriptor) => descriptor),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            const buffer = { size: descriptor.size, destroy: vi.fn(), getMappedRange: () => storage, unmap: vi.fn() } as unknown as GPUBuffer;
            contents.set(buffer, new Uint8Array(storage));
            return buffer;
        }),
        queue: {
            writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
                const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data, dataOffset, size);
                contents.get(buffer)!.set(bytes, offset);
            }),
            writeTexture: vi.fn(),
        },
        limits: { maxTextureDimension2D: 8192 },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [], canvas: { width: 64, height: 64 }, format: "bgra8unorm", msaaSamples: 4 } as unknown as EngineContext;
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
    return { engine, scene, pass, contents };
}

function mesh(material: Mesh["material"]): Mesh {
    const target = Object.assign(createTransformNode("opacity-shader"), {
        material,
        visible: true,
        receiveShadows: false,
        _gpu: { positionBuffer: {}, normalBuffer: {}, uvBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint16" },
    }) as Mesh;
    return target;
}

function texture(): Texture2D {
    return { texture: { createView: () => ({}), destroy: vi.fn() } as unknown as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 1, height: 1 };
}

function shadowLight() {
    const light = createDirectionalLight([0, -1, 0]);
    light.shadowGenerator = {
        _shadowType: "pcf",
        _depthTexture: { createView: () => ({}) },
        _depthSampler: {},
        _shadowUBO: {},
    } as unknown as ShadowGenerator;
    return light;
}

function pipeline(binding: DrawBinding): GPURenderPipelineDescriptor {
    return binding.pipeline as unknown as GPURenderPipelineDescriptor;
}

function fragment(binding: DrawBinding): string {
    return (pipeline(binding).fragment!.module as unknown as GPUShaderModuleDescriptor).code;
}

function meshBinding(binding: DrawBinding, f: ReturnType<typeof fixture>): GPUBindGroupDescriptor {
    f.pass.setBindGroup.mockClear();
    binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
    return f.pass.setBindGroup.mock.calls.find(([group]) => group === 1)![1] as unknown as GPUBindGroupDescriptor;
}

function assertOpacityBinding(binding: DrawBinding, f: ReturnType<typeof fixture>): GPUBuffer {
    const code = compact(fragment(binding));
    const declarations = [...code.matchAll(/@group\(1\)@binding\((\d+)\)var<uniform>meshOpacity:meshOpacityUniforms;/g)];
    expect(declarations).toHaveLength(1);
    expect(code.match(/structmeshOpacityUniforms/g)).toHaveLength(1);
    const index = Number(declarations[0]![1]);
    const group = meshBinding(binding, f);
    const entries = [...group.entries];
    expect(entries.filter((entry) => entry.binding === index)).toHaveLength(1);
    const buffer = (entries.find((entry) => entry.binding === index)!.resource as GPUBufferBinding).buffer;
    expect(buffer.size).toBe(16);
    const layout = group.layout as unknown as GPUBindGroupLayoutDescriptor;
    expect([...layout.entries].find((entry) => entry.binding === index)).toMatchObject({ visibility: 2, buffer: { type: "uniform" } });
    expect(f.engine._device.queue.writeBuffer).toHaveBeenCalledWith(buffer, 0, expect.any(ArrayBuffer), 0, 8);
    return buffer;
}

function composer() {
    return createPbrComposer({
        _singleLightWGSL: "",
        _getSingleLightBlock: null,
        _multiLightWGSL: "",
        _multiLightLoop: "",
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: null,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
}

beforeEach(() => {
    clearStandardPipelineCache();
    clearPbrPipelineCache();
    clearSceneBGLCache();
});

describe("mesh-opacity shader, binding and route contracts", () => {
    it("binds Standard POM and mesh opacity independently while isolating opacity-only materials", () => {
        const f = fixture();
        const height = makeParallaxTexture();
        const material = createStandardMaterial();
        material.diffuseTexture = height;
        setStandardParallaxOcclusion(material, { heightTexture: height });
        const target = mesh(material);
        setMeshOpacity(target, 0.5);
        const opacity = _getStdExtsSorted().find((ext) => ext._id === "0-mesh-opacity")!;
        expect(opacity._feature & stdParallaxOcclusionExt._feature).toBe(0);

        const forward = buildStandardMeshRenderables(f.scene, [target], {}).renderables[0]!;
        const binding = forward.bind(f.engine, signature);
        assertOpacityBinding(binding, f);
        expect(fragment(binding)).toContain("fn parallaxOffset(");
        const group = meshBinding(binding, f);
        expect([...group.entries].some((entry) => entry.resource === height.view)).toBe(true);

        const plain = createStandardMaterial();
        plain.diffuseTexture = height;
        const opacityOnly = mesh(plain);
        setMeshOpacity(opacityOnly, 0.5);
        const plainBinding = buildStandardMeshRenderables(f.scene, [opacityOnly], {}).renderables[0]!.bind(f.engine, signature);
        assertOpacityBinding(plainBinding, f);
        expect(fragment(plainBinding)).not.toContain("parallaxOffset");
    });

    it.each([
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ])("preserves OPAQUE opacity after luminance in real forward and geometry variants (gamma: %s, unlit: %s)", async (gamma, unlit) => {
        const f = fixture();
        const material = createPbrMaterial({
            baseColorTexture: createSolidTexture2D(f.engine, 0.4, 0.6, 0.8, 0.25),
            baseColorFactor: [0.4, 0.6, 0.8, 0.6],
            alphaBlend: false,
            _gammaAlbedo: gamma,
        });
        if (unlit) {
            setPbrUnlit(material);
        }
        const target = mesh(material);
        const colours = new Float32Array([1, 1, 1, 0.5, 1, 1, 1, 0.5, 1, 1, 1, 0.5]);
        const colorBuffer = f.engine._device.createBuffer({ size: colours.byteLength, usage: BU.VERTEX, mappedAtCreation: true });
        new Float32Array(colorBuffer.getMappedRange()).set(colours);
        colorBuffer.unmap();
        Object.assign(target._gpu, { colorBuffer });
        f.scene._groups.set(material._buildGroup, [target]);
        setMeshOpacity(target, 0.1);
        expect(_computeMeshFeatures(target) & ~(1 << 6)).toBe(1 << 22);
        const forward = (await buildPbrRenderables(f.scene, [target], undefined)).renderables[0]!;
        expect(isPbrForwardBuildCurrent(f.scene, forward, target)).toBe(true);
        const geometry = buildPbrGeometryRenderable(
            f.scene,
            target,
            createPbrGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }),
            { _lifetimeDisposers: [] }
        );
        for (const renderable of [forward, geometry]) {
            const binding = renderable.bind(f.engine, signature);
            const buffer = assertOpacityBinding(binding, f);
            const [opacity, policy] = new Float32Array(f.contents.get(buffer)!.buffer, 0, 2);
            expect(opacity).toBeCloseTo(0.1);
            expect(policy).toBe(1);
            const code = compact(fragment(binding));
            expect(code).not.toContain("if(alpha<=0.4){discard;}");
            expect(code).toContain("varalpha=baseColorSample.a*material.baseColorFactor.a;");
            expect(code).toContain("alpha*=input.vColor.a;");
            const policyStatement = renderable === forward ? "if(meshOpacity.policy>0.5){alpha=1.0;}" : "alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;";
            const normalization = code.indexOf(policyStatement);
            expect(normalization).toBeGreaterThan(code.indexOf("alpha*=input.vColor.a;"));
            expect(code.split(policyStatement)).toHaveLength(2);
            expect(normalization).toBeLessThan(code.indexOf(renderable === forward ? "varfinalAlpha=" : "alpha>0.4"));
            if (renderable === forward) {
                expect(code.match(/finalAlpha=finalAlpha\*meshOpacity\.value;/g)).toHaveLength(1);
                expect(code.indexOf("finalAlpha=finalAlpha*meshOpacity.value;")).toBeGreaterThan(code.indexOf("finalAlpha=saturate("));
                const normalizedAlpha = policy! > 0.5 ? 1 : 0.25 * 0.6 * 0.5;
                expect(Math.min(1, normalizedAlpha + 10 ** 2) * opacity!).toBeCloseTo(0.1);
            } else {
                expect(code).not.toContain("finalAlpha=finalAlpha*meshOpacity.value;");
            }
            expect(renderable.isTransparent).toBe(true);
        }
    });

    it("keeps Standard output alpha independent of diffuse-texture alpha when faded", () => {
        const f = fixture();
        const material = createStandardMaterial();
        Object.assign(material, { diffuseTexture: createSolidTexture2D(f.engine, 0.4, 0.6, 0.8, 0.25), alpha: 0.6 });
        const target = mesh(material);
        setMeshOpacity(target, 0.5);
        const forward = buildStandardMeshRenderables(f.scene, [target], {}).renderables[0]!;
        const binding = forward.bind(f.engine, signature);
        assertOpacityBinding(binding, f);
        const code = compact(fragment(binding));
        expect(code).toContain("varalpha=mat.dc.a;");
        expect(code).toContain("if(_ds.a<mat.aCut){discard;}");
        expect(code.match(/_ds\.a/g)).toHaveLength(1);
        expect(code).toContain("alpha=alpha*meshOpacity.value;");
        expect(code).toContain("color=vec4<f32>(color.rgb,color.a*meshOpacity.value);");
        expect(code).not.toContain("if(mat.aCut>0.0&&alpha<=0.4){discard;}");
        expect(
            _getStdExtsSorted()
                .find((ext) => ext._id === "0-mesh-opacity")!
                ._frag(0)!._fragmentSlots!.BC
        ).toBe("alpha = alpha * meshOpacity.value; color = vec4<f32>(color.rgb, color.a * meshOpacity.value);");
    });

    it.each(["standard", "pbr"] as const)("discards faded %s cutouts before geometry data/tag and emit-colour writes, leaving opacity-1 tags unchanged", async (family) => {
        const { _installMeshBlendingGeometrySupport } = await import("../../../packages/babylon-lite/src/frame-graph/geometry-mesh-blending");
        _installMeshBlendingGeometrySupport();
        const f = fixture();
        const standard = createStandardMaterial();
        standard.diffuseTexture = texture();
        standard.alphaCutOff = 0.5;
        const pbr = createPbrMaterial({ baseColorTexture: texture() });
        setPbrAlphaCutoff(pbr, 0.5);
        const material = family === "standard" ? standard : pbr;
        const target = mesh(material);
        target.meshBlendingTag = 1;
        f.scene._groups.set(material._buildGroup, [target]);
        const attachments = [GeometryTextureType.MESH_BLEND_TAG, GeometryTextureType.WORLD_POSITION];
        for (const opacity of [1, 0.5]) {
            setMeshOpacity(target, opacity);
            const forward =
                family === "standard"
                    ? buildStandardMeshRenderables(f.scene, [target], {}).renderables[0]!
                    : (await buildPbrRenderables(f.scene, [target], undefined)).renderables[0]!;
            await preloadStandardGeometryFeatures([target], false);
            const resources = { _lifetimeDisposers: [] as (() => void)[] };
            const geometry =
                family === "standard"
                    ? buildStandardGeometryRenderable(f.scene, target, createStandardGeometryMaterialView(standard, { attachments, emitColor: true }), resources)
                    : buildPbrGeometryRenderable(f.scene, target, createPbrGeometryMaterialView(pbr, { attachments, emitColor: true }), resources);
            const color = compact(fragment(forward.bind(f.engine, signature)));
            const code = compact(fragment(geometry.bind(f.engine, signature)));
            const discard = family === "standard" ? "if(mat.aCut>0.0&&alpha<=0.4){discard;}" : "if(alpha<=0.4){discard;}";
            expect(color).not.toContain(discard);
            expect(code).toContain(
                family === "standard" ? "out.meshBlendTag0=select(select(0u,mesh.lc>>8u,alpha>0.4),mesh.lc>>8u,mat.aCut>0.0);" : "out.meshBlendTag0=mesh.lc>>8u;"
            );
            if (opacity < 1) {
                const multiply = family === "standard" ? "alpha=alpha*meshOpacity.value;" : "alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;";
                const cutoff = code.indexOf(discard);
                expect(cutoff).toBeGreaterThan(code.indexOf(multiply));
                expect(cutoff).toBeLessThan(code.indexOf("out.meshBlendTag0="));
                expect(cutoff).toBeLessThan(code.indexOf("out.f1="));
                expect(cutoff).toBeLessThan(code.indexOf("out.color="));
                if (family === "standard") {
                    expect(code.indexOf("var<uniform>mat:")).toBeGreaterThan(-1);
                }
            } else {
                expect(code).not.toContain("meshOpacity");
                expect(code).not.toContain(discard);
            }
            resources._lifetimeDisposers.forEach((dispose) => dispose());
        }
    });

    it("keeps opacity-1 WGSL, generation requests, pipeline state and binding counts identical to pre-installation", async () => {
        const f = fixture();
        const standard = mesh(createStandardMaterial());
        const pbr = mesh(createPbrMaterial());
        f.scene._groups.set(pbr.material!._buildGroup, [pbr]);
        const build = async () => {
            const std = buildStandardMeshRenderables(f.scene, [standard], {}).renderables[0]!;
            const p = (await buildPbrRenderables(f.scene, [pbr], undefined)).renderables[0]!;
            return [std, p].map((renderable) => {
                const binding = renderable.bind(f.engine, signature);
                return {
                    code: fragment(binding),
                    entries: [...meshBinding(binding, f).entries].map((entry) => entry.binding),
                    depth: pipeline(binding).depthStencil,
                    targets: pipeline(binding).fragment!.targets,
                    multisample: pipeline(binding).multisample,
                    transparent: renderable.isTransparent,
                    generation: renderable._gen?.slice(1, 5),
                };
            });
        };
        const before = await build();
        expect(before.every((state) => !state.code.includes("meshOpacity"))).toBe(true);
        setMeshOpacity(standard, 1);
        const after = await build();
        expect(after).toEqual(before);
    });

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])("orders Standard BC after cutoff and before fog/instance alpha (unlit=%s, fog=%s), with matching main/geometry bindings", async (unlit, fog) => {
        const f = fixture();
        const material = createStandardMaterial();
        material.disableLighting = unlit;
        material.diffuseTexture = texture();
        material.diffuseTexture.uScale = 2;
        material.alphaCutOff = 0.5;
        material._hasUvTx = true;
        material.lightmapCoordIndex = 0;
        setStandardLightmapTexture(material, texture());
        _registerStdExt(stdUvTransformExt);
        _installStdVertexColorFragment(createStdVertexColorFragment);
        const target = mesh(material);
        target.receiveShadows = true;
        target.hasVertexAlpha = true;
        Object.assign(target._gpu, { colorBuffer: {} as GPUBuffer });
        setThinInstances(target, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 1);
        setThinInstanceColors(target, new Float32Array([1, 1, 1, 0.8]));
        f.scene.lights.push(shadowLight());
        setMeshOpacity(target, 0.5);
        const forward = buildStandardMeshRenderables(f.scene, [target], {
            tiFragment: createThinInstanceFragment,
            shadow: await createStandardShadowContext(f.engine, f.scene.lights),
            sceneShader: fog ? { _features: STD_SCENE_FOG, _fragments: [createStandardFogFragment()] } : null,
        }).renderables[0]!;
        await preloadStandardGeometryFeatures([target], false);
        const view = createStandardGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false });
        const geometry = buildStandardGeometryRenderable(f.scene, target, view, { _lifetimeDisposers: [] });
        const main = forward.bind(f.engine, signature);
        const auxiliary = geometry.bind(f.engine, signature);
        for (const binding of [main, auxiliary]) {
            assertOpacityBinding(binding, f);
            const code = compact(fragment(binding));
            const multiply = code.indexOf("alpha=alpha*meshOpacity.value;");
            expect(code.match(/alpha=alpha\*meshOpacity\.value;/g)).toHaveLength(1);
            expect(code.match(/color\.a\*meshOpacity\.value/g)).toHaveLength(1);
            expect(code.indexOf("discard;")).toBeGreaterThan(-1);
            expect(multiply).toBeGreaterThan(code.indexOf("discard;"));
            if (fog) {
                expect(code.indexOf("mix(scene.vFogColor.rgb,color.rgb,fog)")).toBeGreaterThan(multiply);
            }
            expect(pipeline(binding).depthStencil!.depthWriteEnabled).toBe(false);
            expect([...pipeline(binding).fragment!.targets][0]!.blend).toBeDefined();
        }
        const color = compact(fragment(main));
        expect(color.indexOf("color.a*input.vInstanceColor.a")).toBeGreaterThan(color.indexOf("color.a*meshOpacity.value"));
        expect(compact(fragment(auxiliary)).indexOf("alpha>0.4")).toBeGreaterThan(compact(fragment(auxiliary)).indexOf("alpha=alpha*meshOpacity.value;"));
        expect([forward.isTransparent, forward.order, geometry.isTransparent, geometry.order]).toEqual([true, 200, true, 200]);
    });

    it("fades a shadow-only material at 0.5 with policy zero without replacing its shadow mask", async () => {
        const f = fixture();
        f.scene.camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        f.scene.lights.push(shadowLight());
        addClusteredLightContainer(f.scene, createClusteredLightContainer({ horizontalTiles: 1, verticalTiles: 1, zSlices: 1 }));
        const material = createPbrMaterial({ alphaBlend: false });
        setShadowOnly(material);
        const target = mesh(material);
        target.receiveShadows = true;
        f.scene._groups.set(material._buildGroup, [target]);
        setMeshOpacity(target, 0.5);
        const forward = (await buildPbrRenderables(f.scene, [target], undefined)).renderables[0]!;
        const binding = forward.bind(f.engine, signature);
        const buffer = assertOpacityBinding(binding, f);
        expect(Array.from(new Float32Array(f.contents.get(buffer)!.buffer, 0, 2))).toEqual([0.5, 0]);
        const code = compact(fragment(binding));
        const policyBC = "if(meshOpacity.policy>0.5){alpha=1.0;}";
        expect(code.split(policyBC)).toHaveLength(2);
        expect(code.indexOf(policyBC)).toBeGreaterThan(code.indexOf("alpha=saturate((1.0-so_shadowMin)"));
        expect(code.indexOf(policyBC)).toBeLessThan(code.indexOf("varfinalAlpha="));
        expect(code.match(/finalAlpha=finalAlpha\*meshOpacity\.value;/g)).toHaveLength(1);
        expect(code.indexOf("finalAlpha=finalAlpha*meshOpacity.value;")).toBeGreaterThan(code.lastIndexOf("finalAlpha=alpha*material.materialAlpha;"));
    });

    it("orders PBR FA after saturate and shadow-only, preserves cutoff order, and matches clustered main/geometry binding indices", async () => {
        const f = fixture();
        f.scene.camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        f.scene.lights.push(shadowLight());
        const material = createPbrMaterial({ baseColorTexture: texture(), alphaBlend: false });
        setPbrAlphaCutoff(material, 0.5);
        setShadowOnly(material);
        const target = mesh(material);
        f.scene._groups.set(material._buildGroup, [target]);
        target.receiveShadows = true;
        f.scene.meshes.push(target);
        addClusteredLightContainer(f.scene, createClusteredLightContainer({ horizontalTiles: 1, verticalTiles: 1, zSlices: 1 }));
        setMeshOpacity(target, 0.5);
        const forward = (await buildPbrRenderables(f.scene, [target], undefined)).renderables[0]!;
        const geometry = buildPbrGeometryRenderable(
            f.scene,
            target,
            createPbrGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }),
            { _lifetimeDisposers: [] }
        );
        const main = forward.bind(f.engine, signature);
        const auxiliary = geometry.bind(f.engine, signature);
        for (const binding of [main, auxiliary]) {
            assertOpacityBinding(binding, f);
            const code = compact(fragment(binding));
            expect(code).toContain("clusteredLightParams");
            const multiply = code.indexOf(binding === main ? "finalAlpha=finalAlpha*meshOpacity.value;" : "alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;");
            expect(multiply).toBeGreaterThan(code.indexOf("discard;"));
            expect(pipeline(binding).depthStencil!.depthWriteEnabled).toBe(false);
            expect([...pipeline(binding).fragment!.targets][0]!.blend).toBeDefined();
        }
        const color = compact(fragment(main));
        const multiply = color.indexOf("finalAlpha=finalAlpha*meshOpacity.value;");
        expect(color.match(/finalAlpha=finalAlpha\*meshOpacity\.value;/g)).toHaveLength(1);
        expect(multiply).toBeGreaterThan(color.indexOf("finalAlpha=saturate("));
        expect(multiply).toBeGreaterThan(color.lastIndexOf("finalAlpha=alpha*material.materialAlpha;"));
        expect(multiply).toBeLessThan(color.indexOf("returnvec4<f32>(color,finalAlpha);"));
        const geo = compact(fragment(auxiliary));
        expect(geo.indexOf("alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;")).toBeGreaterThan(geo.indexOf("alpha=saturate((1.0-so_shadowMin)"));
        expect(geo.indexOf("alpha>0.4")).toBeGreaterThan(geo.indexOf("alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;"));
        expect([forward.isTransparent, forward.order, geometry.isTransparent, geometry.order]).toEqual([true, 150, true, 200]);
        expect(isPbrForwardBuildCurrent(f.scene, forward, target)).toBe(true);
        setMeshOpacity(target, 0.4);
        expect(isPbrForwardBuildCurrent(f.scene, forward, target)).toBe(true);
        setMeshOpacity(target, 1);
        expect(isPbrForwardBuildCurrent(f.scene, forward, target)).toBe(false);
    });

    it.each([false, true])("puts geometry opacity outside the real linear-image-processing refraction brace (BLEND: %s)", (alphaBlend) => {
        const material = createPbrMaterial({ _subsurface: { refraction: { intensity: 1 } }, _transmissive: true, alphaBlend });
        Object.assign(material, { _linearImageProcessing: true });
        const refraction = makeRefractionRttExt();
        _registerPbrExt(iblExt);
        _registerPbrExt(refraction);
        const detected = refraction.detect!(material);
        const target = mesh(material);
        setMeshOpacity(target, 0.5);
        const meshFeatures = _computeMeshFeatures(target);
        const composed = composePbrGeometryShader(
            composer(),
            detected.f | ((meshFeatures >>> 16) & PBR_HAS_ALPHA_BLEND),
            detected.f2,
            meshFeatures,
            PBR_HAS_ENV,
            0,
            "",
            "",
            undefined,
            "",
            [GeometryTextureType.WORLD_POSITION],
            false
        );
        expect(composed._fragmentKey).toContain("refraction");
        const code = compact(composed._fragmentWGSL);
        const start = code.indexOf("if(scene.vImageInfos.w>=0.0){");
        expect(start).toBeGreaterThan(-1);
        let depth = 1;
        let end = code.indexOf("{", start) + 1;
        for (; depth && end < code.length; end++) {
            depth += code[end] === "{" ? 1 : code[end] === "}" ? -1 : 0;
        }
        const multiply = code.indexOf("alpha=select(alpha,1.0,meshOpacity.policy>0.5)*meshOpacity.value;");
        expect(depth).toBe(0);
        expect(multiply).toBeGreaterThan(end - 1);
        expect(multiply).toBeLessThan(code.indexOf("alpha>0.4"));
    });

    it.each(["standard", "pbr"] as const)("leaves raw %s colour/geometry draws unwrapped and no-colour/ESM shadow routes opaque", async (family) => {
        const f = fixture();
        const standard = createStandardMaterial();
        const pbr = createPbrMaterial();
        const target = mesh(family === "standard" ? standard : pbr);
        f.scene._groups.set(target.material!._buildGroup, [target]);
        setMeshOpacity(target, 0.6);
        const forward = family === "standard" ? buildStandardMeshRenderables(f.scene, [target], {}) : await buildPbrRenderables(f.scene, [target], undefined);
        const geometry =
            family === "standard"
                ? buildStandardGeometryRenderable(
                      f.scene,
                      target,
                      createStandardGeometryMaterialView(standard, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }),
                      { _lifetimeDisposers: [] }
                  )
                : buildPbrGeometryRenderable(f.scene, target, createPbrGeometryMaterialView(pbr, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }), {
                      _lifetimeDisposers: [],
                  });
        const bindings = [forward.renderables[0]!, geometry].map((renderable) => renderable.bind(f.engine, signature));
        setMeshOpacity(target, 0);
        for (const binding of bindings) {
            f.pass.drawIndexed.mockClear();
            // Task loops, not binding wrappers, own the live zero-opacity filter.
            expect(binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine)).toBe(1);
            expect(f.pass.drawIndexed).toHaveBeenCalledTimes(1);
        }
        setMeshOpacity(target, 0.3);
        for (const binding of bindings) {
            f.pass.drawIndexed.mockClear();
            expect(binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine)).toBe(1);
            expect(f.pass.drawIndexed).toHaveBeenCalledTimes(1);
        }
        setMeshOpacity(target, 0);
        const params = {} as GPUBuffer;
        const views =
            family === "standard"
                ? [createStandardNoColorMaterialView(standard), createStandardEsmShadowMaterialView(standard, params)]
                : [createPbrNoColorMaterialView(pbr), createPbrEsmShadowMaterialView(pbr, params)];
        for (const [index, view] of views.entries()) {
            const shadow = forward.rebuildSingle!(f.scene, target, view);
            const binding = shadow.bind(f.engine, { _colorFormat: index ? "rgba16float" : undefined, _depthStencilFormat: "depth32float", _sampleCount: 1 });
            expect(fragment(binding)).not.toContain("meshOpacity");
            f.pass.drawIndexed.mockClear();
            expect(binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine)).toBe(1);
            expect(f.pass.drawIndexed).toHaveBeenCalledTimes(1);
            expect(shadow.isTransparent).toBe(false);
        }
    });

    it.each(["standard", "pbr"] as const)("keeps %s A2C and forced blend simultaneously in pipeline keys and descriptors", (family) => {
        const f = fixture();
        const standard = createStandardMaterial();
        const pbr = createPbrMaterial();
        const target = mesh(family === "standard" ? standard : pbr);
        setAlphaToCoverage(target.material, true);
        setMeshOpacity(target, 0.5);
        let keys: string[];
        let descriptor: GPURenderPipelineDescriptor;
        if (family === "standard") {
            const ext = _getStdExtsSorted().find((entry) => entry._id === "0-mesh-opacity")!;
            const features = ext._meshFeatures!(_computeMeshFeatures(target), standard);
            const bindings = getOrCreateStandardBindings(f.engine, features, 0, [ext._frag(features)]);
            descriptor = getOrCreateStandardPipeline(f.engine, signature, bindings, standard) as unknown as GPURenderPipelineDescriptor;
            keys = [...bindings._pipelines.keys()];
            expect(features & MATERIAL_ALPHA_BLEND).not.toBe(0);
            expect(composeStandardShader(features, 0, [ext._frag(features)])._fragmentWGSL).toContain("meshOpacity");
        } else {
            const meshFeatures = _computeMeshFeatures(target);
            const features = (meshFeatures >>> 16) & PBR_HAS_ALPHA_BLEND;
            const composed = composer()(features, 0, meshFeatures);
            const bindings = getOrCreatePbrBindings(f.engine, features, 0, meshFeatures, 0, composed);
            descriptor = getOrCreatePbrPipeline(f.engine, signature, bindings, pbr) as unknown as GPURenderPipelineDescriptor;
            keys = [...bindings._pipelines.keys()];
            expect(features & PBR_HAS_ALPHA_BLEND).not.toBe(0);
        }
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/:a2c$/);
        expect(descriptor.multisample).toMatchObject({ count: 4, alphaToCoverageEnabled: true });
        expect([...descriptor.fragment!.targets][0]!.blend).toBeDefined();
        expect(descriptor.depthStencil!.depthWriteEnabled).toBe(false);
    });

    it.each(["standard", "pbr"] as const)("preserves mirrored %s winding and PBR VAT vertex bindings alongside main/geometry opacity", async (family) => {
        const f = fixture();
        await enableMirroredMeshes(f.scene);
        const standard = createStandardMaterial();
        const pbr = createPbrMaterial();
        const target = mesh(family === "standard" ? standard : pbr);
        target.scaling.x = -1;
        if (family === "pbr") {
            _registerPbrExt(vatExt);
            const skin = { jointsBuffer: {} as GPUBuffer, weightsBuffer: {} as GPUBuffer, joints1Buffer: null, weights1Buffer: null };
            const baked = texture().texture;
            target.vat = {
                ...skin,
                boneCount: 1,
                frameCount: 1,
                texture: baked,
                settingsBuffer: {} as GPUBuffer,
                _textureResource: { texture: baked },
                _skinBuffers: skin,
            };
        }
        f.scene._groups.set(target.material!._buildGroup, [target]);
        setMeshOpacity(target, 0.5);
        const forward =
            family === "standard" ? buildStandardMeshRenderables(f.scene, [target], {}).renderables[0]! : (await buildPbrRenderables(f.scene, [target], undefined)).renderables[0]!;
        const geometry =
            family === "standard"
                ? buildStandardGeometryRenderable(
                      f.scene,
                      target,
                      createStandardGeometryMaterialView(standard, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }),
                      { _lifetimeDisposers: [] }
                  )
                : buildPbrGeometryRenderable(f.scene, target, createPbrGeometryMaterialView(pbr, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false }), {
                      _lifetimeDisposers: [],
                  });
        for (const binding of [forward, geometry].map((renderable) => renderable.bind(f.engine, signature))) {
            assertOpacityBinding(binding, f);
            expect(pipeline(binding).primitive).toMatchObject({ frontFace: "cw", cullMode: "back" });
            expect(pipeline(binding).depthStencil!.depthWriteEnabled).toBe(false);
            if (family === "pbr") {
                expect((pipeline(binding).vertex.module as unknown as GPUShaderModuleDescriptor).code).toContain("readMatrixFromVat");
                const entries = [...meshBinding(binding, f).entries];
                expect(entries.some((entry) => (entry.resource as GPUBufferBinding).buffer === target.vat!.settingsBuffer)).toBe(true);
            }
        }
    });
});
