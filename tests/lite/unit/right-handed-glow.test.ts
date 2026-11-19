import { afterEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { GlowMaterialContext } from "../../../packages/babylon-lite/src/material/glow/glow-material";
import { bothBuilds, resetBuild, SRC } from "./right-handed-builds";

afterEach(resetBuild);

describe("right-handed glow material", () => {
    it("reverses procedural front faces and preserves the loader's explicit RH winding and PBR topology", async () => {
        const [lh, rh] = await bothBuilds(async () => {
            const { createGlowDraw, updateGlowDraw } = await import(`${SRC}material/glow/glow-material`);
            const { readGlowSurface } = await import(`${SRC}material/glow/glow-source`);
            const { createStandardMaterial } = await import(`${SRC}material/standard/create-standard-material`);
            const { createPbrMaterial } = await import(`${SRC}material/pbr/pbr-material`);
            const pipelines: GPURenderPipelineDescriptor[] = [];
            const device = Object.assign({} as GPUDevice, {
                createBuffer: () => ({}) as GPUBuffer,
                createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
                createPipelineLayout: () => ({}) as GPUPipelineLayout,
                createShaderModule: () => ({}) as GPUShaderModule,
                createBindGroup: () => ({}) as GPUBindGroup,
                createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
                    pipelines.push(descriptor);
                    return {} as GPURenderPipeline;
                },
                queue: { writeBuffer() {} },
            });
            const engine = Object.assign({} as EngineContext, { _device: device });
            const context: GlowMaterialContext = {
                engine,
                scene: {} as SceneContext,
                format: "rgba8unorm",
                variants: new Map(),
                programs: new Map(),
                targetTexture: null,
                frame: 0,
                skeleton: null,
                morph: null,
                instances: null,
                syncInstances: null,
                updateInstances: null,
                node: null,
                loading: null,
            };
            const mesh = Object.assign({} as Mesh, {
                material: createStandardMaterial(),
                worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
                _gpu: {},
                _primitiveFeatures: 0,
            });
            const draw = createGlowDraw(context, mesh);
            readGlowSurface(mesh.material, draw.surface);
            updateGlowDraw(context, draw, true, draw.surface.color);
            mesh._primitiveFeatures = 1 << 11;
            updateGlowDraw(context, draw, true, draw.surface.color);
            // A mirrored glTF line primitive, as pre-encoded by the loader's primitive feature.
            const lines = Object.assign({} as Mesh, {
                material: createPbrMaterial({}),
                worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
                _gpu: {},
                _primitiveFeatures: (1 << 11) | (2 << 12),
                _primitive: { topology: "line-list", frontFace: "cw" },
            });
            const lineDraw = createGlowDraw(context, lines);
            readGlowSurface(lines.material, lineDraw.surface);
            updateGlowDraw(context, lineDraw, true, lineDraw.surface.color);
            return pipelines.map((pipeline) => [pipeline.primitive!.frontFace, pipeline.primitive!.topology ?? "triangle-list"]);
        });
        expect(lh).toEqual([
            ["ccw", "triangle-list"],
            ["cw", "line-list"],
        ]);
        expect(rh).toEqual([
            ["cw", "triangle-list"],
            ["ccw", "triangle-list"],
            ["ccw", "line-list"],
        ]);
    });
});
