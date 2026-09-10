import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCsmDirectionalShadowGenerator, createEsmDirectionalShadowGenerator, setShadowTaskCasterMeshes } = vi.hoisted(() => ({
    createCsmDirectionalShadowGenerator: vi.fn(() => ({ kind: "csm" })),
    createEsmDirectionalShadowGenerator: vi.fn(() => ({ kind: "esm" })),
    setShadowTaskCasterMeshes: vi.fn(),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    createCsmDirectionalShadowGenerator,
    createEsmDirectionalShadowGenerator,
    setShadowTaskCasterMeshes,
}));

import type { EngineContext, Mesh as LiteMesh } from "babylon-lite";

import { NullEngine } from "../src/engine/engine";
import { DirectionalLight, SpotLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";
import { AbstractMesh, TransformNode } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";
import { CascadedShadowGenerator, ShadowGenerator } from "../src/shadows/shadow-generator";

function createTestMesh(name: string): AbstractMesh {
    return new AbstractMesh(name, { name, visible: true, children: [], receiveShadows: false } as unknown as LiteMesh);
}

async function flushCasterSync(): Promise<void> {
    await Promise.resolve();
}

describe("ShadowGenerator caster synchronization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("supplies pre-build casters once when the native generator is built", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");

        generator.addShadowCaster(caster);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();

        generator._build({} as EngineContext);

        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith({ kind: "esm" }, [caster._lite]);
    });

    it("coalesces runtime additions and removals into one final native caster set", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const first = createTestMesh("first");
        const second = createTestMesh("second");
        const third = createTestMesh("third");
        generator.addShadowCaster(first);
        generator._build({} as EngineContext);
        const liteGenerator = generator._liteGen;
        vi.clearAllMocks();

        generator.addShadowCaster(second);
        generator.addShadowCaster(third);

        expect(generator.getShadowMap().renderList).toEqual([first, second, third]);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(generator._liteGen).toBe(liteGenerator);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(liteGenerator, [first._lite, second._lite, third._lite]);

        vi.clearAllMocks();
        generator.removeShadowCaster(first);
        generator.removeShadowCaster(second);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(liteGenerator, [third._lite]);
    });

    it("does not resupply for duplicate additions or absent removals", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        const duplicateWrapper = new AbstractMesh("duplicate", caster._lite);
        const absent = createTestMesh("absent");
        generator.addShadowCaster(caster);
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.addShadowCaster(caster);
        generator.addShadowCaster(duplicateWrapper);
        generator.removeShadowCaster(absent);
        await flushCasterSync();

        expect(generator.getShadowMap().renderList).toEqual([caster]);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
    });

    it("includes descendant meshes by default and excludes transform-only nodes", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const root = createTestMesh("root");
        const directMesh = createTestMesh("direct");
        const transform = new TransformNode("transform");
        const nestedMesh = createTestMesh("nested");
        directMesh.parent = root;
        transform.parent = root;
        nestedMesh.parent = transform;
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.addShadowCaster(root);
        generator.addShadowCaster(directMesh);
        await flushCasterSync();

        expect(generator.getShadowMap().renderList).toEqual([root, directMesh, nestedMesh]);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, [root._lite, directMesh._lite, nestedMesh._lite]);

        vi.clearAllMocks();
        generator.removeShadowCaster(root);
        await flushCasterSync();

        expect(generator.getShadowMap().renderList).toEqual([]);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, []);
    });

    it("limits additions and removals to the requested mesh when includeDescendants is false", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const root = createTestMesh("root");
        const child = createTestMesh("child");
        child.parent = root;
        generator.addShadowCaster(root, false);
        expect(generator.getShadowMap().renderList).toEqual([root]);
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.removeShadowCaster(root, false);
        await flushCasterSync();

        expect(generator.getShadowMap().renderList).toEqual([]);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, []);
    });

    it("flushes mutations made during before-render callbacks before Lite renders", async () => {
        const flushCallbacks: (() => void)[] = [];
        const scene = {
            _registerShadowGenerator: vi.fn(),
            _registerBeforeRenderFlush: (callback: () => void) => {
                flushCallbacks.push(callback);
                return () => {
                    const index = flushCallbacks.indexOf(callback);
                    if (index !== -1) {
                        flushCallbacks.splice(index, 1);
                    }
                };
            },
        } as unknown as Scene;
        const light = new DirectionalLight("directional", new Vector3(0, -1, -1));
        vi.spyOn(light, "getScene").mockReturnValue(scene);
        const generator = new ShadowGenerator(1024, light);
        const caster = createTestMesh("caster");
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.addShadowCaster(caster);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
        flushCallbacks[0]!();

        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, [caster._lite]);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
    });

    it("removes scene flush callbacks when generators are repeatedly created and disposed", () => {
        const scene = new Scene(new NullEngine());
        const flush = vi.fn();
        const unregisterFlush = scene._registerBeforeRenderFlush(flush);

        scene._tick(16);
        expect(flush).toHaveBeenCalledOnce();
        unregisterFlush();
        unregisterFlush();
        scene._tick(16);
        expect(flush).toHaveBeenCalledOnce();

        const activeFlushCallbacks = new Set<() => void>();
        const generatorScene = {
            _registerShadowGenerator: vi.fn(),
            _registerBeforeRenderFlush: (callback: () => void) => {
                activeFlushCallbacks.add(callback);
                return () => {
                    activeFlushCallbacks.delete(callback);
                };
            },
        } as unknown as Scene;
        const light = new DirectionalLight("directional", new Vector3(0, -1, -1));
        vi.spyOn(light, "getScene").mockReturnValue(generatorScene);

        for (let i = 0; i < 3; i++) {
            const generator = new ShadowGenerator(1024, light);
            generator.dispose();
            generator.dispose();
        }

        expect(activeFlushCallbacks.size).toBe(0);
    });

    it("clears pending native caster synchronization on disposal", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.addShadowCaster(caster);
        generator.dispose();
        await flushCasterSync();

        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
    });
});

describe("CascadedShadowGenerator", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards Babylon.js CSM settings to the native Lite generator", () => {
        const light = new DirectionalLight("directional", new Vector3(0, -1, -1));
        const generator = new CascadedShadowGenerator(2048, light);
        generator.numCascades = 3;
        generator.lambda = 0.7;
        generator.cascadeBlendPercentage = 0.2;
        generator.stabilizeCascades = true;
        generator.shadowMaxZ = 500;
        generator.bias = 0.001;
        generator.darkness = 0.25;
        generator.frustumEdgeFalloff = 0.15;

        generator._build({} as EngineContext);

        expect(createCsmDirectionalShadowGenerator).toHaveBeenCalledWith({}, light._lite, {
            mapSize: 2048,
            numCascades: 3,
            lambda: 0.7,
            cascadeBlendPercentage: 0.2,
            stabilizeCascades: true,
            shadowMaxZ: 500,
            bias: 0.001,
            darkness: 0.25,
            frustumEdgeFalloff: 0.15,
        });
        expect(light._lite.shadowGenerator).toEqual({ kind: "csm" });
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith({ kind: "csm" }, []);
    });

    it("clamps the cascade count to the Babylon.js range", () => {
        const generator = new CascadedShadowGenerator(2048, new DirectionalLight("directional", new Vector3(0, -1, -1)));

        generator.numCascades = 0;
        expect(generator.numCascades).toBe(2);
        generator.numCascades = 1;
        expect(generator.numCascades).toBe(2);
        generator.numCascades = 4;
        expect(generator.numCascades).toBe(4);
        generator.numCascades = 5;
        expect(generator.numCascades).toBe(4);
    });

    it("rejects non-directional lights before building", () => {
        const light = new SpotLight("spot", Vector3.Zero(), new Vector3(0, -1, 0), Math.PI / 2, 1);

        expect(() => new CascadedShadowGenerator(2048, light as unknown as DirectionalLight)).toThrow("CascadedShadowGenerator requires a DirectionalLight");
        expect(createCsmDirectionalShadowGenerator).not.toHaveBeenCalled();
    });

    it("resupplies runtime casters to the same native CSM generator", async () => {
        const generator = new CascadedShadowGenerator(2048, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        generator._build({} as EngineContext);
        const liteGenerator = generator._liteGen;
        vi.clearAllMocks();

        generator.addShadowCaster(caster);
        await flushCasterSync();

        expect(generator._liteGen).toBe(liteGenerator);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(liteGenerator, [caster._lite]);
    });
});
