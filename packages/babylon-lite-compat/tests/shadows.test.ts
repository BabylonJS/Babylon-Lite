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

import type { AssetContainer as LiteAssetContainer, EngineContext, Mesh as LiteMesh } from "babylon-lite";

import { NullEngine } from "../src/engine/engine";
import { DirectionalLight, SpotLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";
import { collectLoadedMeshes, type LoadedMeshRegistry } from "../src/loading/loaded-mesh";
import { AbstractMesh, TransformNode } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";
import { CascadedShadowGenerator, ShadowGenerator } from "../src/shadows/shadow-generator";

/** A geometry-backed caster: only Lite meshes carrying `_gpu` reach the native shadow task. */
function createTestMesh(name: string): AbstractMesh {
    return new AbstractMesh(name, { name, visible: true, children: [], receiveShadows: false, _gpu: {} } as unknown as LiteMesh);
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

    it("removes disposed pre-build casters from the render list and initial native set", () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        generator.addShadowCaster(caster);

        caster.dispose();

        expect(generator.getShadowMap().renderList).toEqual([]);
        generator._build({} as EngineContext);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith({ kind: "esm" }, []);
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
        duplicateWrapper.dispose();
        await flushCasterSync();

        expect(generator.getShadowMap().renderList).toEqual([caster]);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
    });

    it("replaces and cleans up a same-wrapper observer after direct render-list mutations", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        const removeObserver = vi.spyOn(caster.onDisposeObservable, "remove");
        generator.addShadowCaster(caster);
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.getShadowMap().renderList.splice(0);
        generator.addShadowCaster(caster);

        expect(removeObserver).toHaveBeenCalledOnce();
        expect(caster.onDisposeObservable.hasObservers()).toBe(true);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, [caster._lite]);
        vi.clearAllMocks();

        generator.getShadowMap().renderList.splice(0);
        generator.removeShadowCaster(caster);
        await flushCasterSync();

        expect(caster.onDisposeObservable.hasObservers()).toBe(false);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
    });

    it("ignores a stale disposal callback after replacing a wrapper for the same Lite mesh", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const first = createTestMesh("first");
        const replacement = new AbstractMesh("replacement", first._lite);
        first.onDisposeObservable.add(() => {
            generator.getShadowMap().renderList.splice(0);
            generator.addShadowCaster(replacement);
        });
        generator.addShadowCaster(first);
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        first.dispose();

        expect(generator.getShadowMap().renderList).toEqual([replacement]);
        expect(replacement.onDisposeObservable.hasObservers()).toBe(true);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, [replacement._lite]);
    });

    it("coalesces same-turn caster disposals into one final native caster set", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const first = createTestMesh("first");
        const second = createTestMesh("second");
        const remaining = createTestMesh("remaining");
        generator.addShadowCaster(first).addShadowCaster(second).addShadowCaster(remaining);
        generator._build({} as EngineContext);
        const liteGenerator = generator._liteGen;
        vi.clearAllMocks();

        first.dispose();
        second.dispose();

        expect(generator.getShadowMap().renderList).toEqual([remaining]);
        expect(setShadowTaskCasterMeshes).not.toHaveBeenCalled();
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(liteGenerator, [remaining._lite]);
    });

    it("removes recursively disposed descendants and updates every owning generator", async () => {
        const firstGenerator = new ShadowGenerator(1024, new DirectionalLight("first-light", new Vector3(0, -1, -1)));
        const secondGenerator = new ShadowGenerator(1024, new DirectionalLight("second-light", new Vector3(0, -1, -1)));
        const root = createTestMesh("root");
        const child = createTestMesh("child");
        const grandchild = createTestMesh("grandchild");
        child.parent = root;
        grandchild.parent = child;
        firstGenerator.addShadowCaster(root);
        secondGenerator.addShadowCaster(child);
        firstGenerator._build({} as EngineContext);
        secondGenerator._build({} as EngineContext);
        const firstLiteGenerator = firstGenerator._liteGen;
        const secondLiteGenerator = secondGenerator._liteGen;
        vi.clearAllMocks();

        root.dispose();

        expect(firstGenerator.getShadowMap().renderList).toEqual([]);
        expect(secondGenerator.getShadowMap().renderList).toEqual([]);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledTimes(2);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(firstLiteGenerator, []);
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(secondLiteGenerator, []);
    });

    it("detaches disposal observers after manual removal", async () => {
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        generator.addShadowCaster(caster);
        generator._build({} as EngineContext);
        vi.clearAllMocks();

        generator.removeShadowCaster(caster);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(caster.onDisposeObservable.hasObservers()).toBe(false);
        vi.clearAllMocks();

        caster.dispose();
        await flushCasterSync();
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

    it("forwards only geometry-backed Lite meshes of a loaded hierarchy, keeping the full renderList", async () => {
        // The compat loader wraps the whole hierarchy as `Mesh` wrappers: a transform-only `__root__`, a
        // transform-only intermediate node, and the geometry-backed leaves (`_gpu`) under them.
        type FakeLite = { name: string; children: FakeLite[]; visible: boolean; _gpu?: object };
        const leaf = (name: string): FakeLite => ({ name, children: [], visible: true, _gpu: {} });
        const body = leaf("body");
        const wheel = leaf("wheel");
        const intermediate: FakeLite = { name: "chassis", children: [body, wheel], visible: true };
        const root: FakeLite = { name: "__root__", children: [intermediate], visible: true };
        const registry: LoadedMeshRegistry = new Map();
        const [rootWrapper] = collectLoadedMeshes({ entities: [root] } as unknown as LiteAssetContainer, registry);
        const generator = new ShadowGenerator(1024, new DirectionalLight("directional", new Vector3(0, -1, -1)));

        generator.addShadowCaster(rootWrapper!, true);
        // Babylon.js parity: the render list holds every node the caller asked for, geometry or not.
        expect(generator.getShadowMap().renderList.map((mesh) => mesh.name)).toEqual(["__root__", "chassis", "body", "wheel"]);

        generator._build({} as EngineContext);
        // Only the geometry-backed leaves enter the native state (and hence directional fitting).
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith({ kind: "esm" }, [body, wheel]);

        // The runtime re-supply path applies the same rule.
        const spare = leaf("spare");
        const [spareRoot] = collectLoadedMeshes({ entities: [{ name: "__root__", children: [spare], visible: true }] } as unknown as LiteAssetContainer, new Map());
        vi.clearAllMocks();
        generator.addShadowCaster(spareRoot!, true);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(generator._liteGen, [body, wheel, spare]);
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
        generator.dispose();
        expect(caster.onDisposeObservable.hasObservers()).toBe(false);
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

    it("removes disposed casters from the native CSM generator", async () => {
        const generator = new CascadedShadowGenerator(2048, new DirectionalLight("directional", new Vector3(0, -1, -1)));
        const caster = createTestMesh("caster");
        generator.addShadowCaster(caster);
        generator._build({} as EngineContext);
        const liteGenerator = generator._liteGen;
        vi.clearAllMocks();

        caster.dispose();

        expect(generator.getShadowMap().renderList).toEqual([]);
        await flushCasterSync();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledOnce();
        expect(setShadowTaskCasterMeshes).toHaveBeenCalledWith(liteGenerator, []);
    });
});
