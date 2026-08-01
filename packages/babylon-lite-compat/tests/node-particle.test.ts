import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        parseNodeParticleSetFromSnippet: vi.fn(),
        registerNodeParticleSet: vi.fn(),
        stopParticleSystem: vi.fn(),
        startParticleSystem: vi.fn(),
        animateParticleSystem: vi.fn(),
        createParticleBillboard: vi.fn(() => ({ billboard: true })),
        syncParticleBillboard: vi.fn(),
        addFacingBillboardSystem: vi.fn(),
    };
});

import {
    parseNodeParticleSetFromSnippet,
    registerNodeParticleSet,
    stopParticleSystem,
    startParticleSystem,
    animateParticleSystem,
    createParticleBillboard,
    syncParticleBillboard,
    addFacingBillboardSystem,
} from "babylon-lite";
import type { NodeParticleSet as LiteNodeParticleSet } from "babylon-lite";

import { LiteCompatError } from "../src/error";
import { NodeParticleSystemSet, ParticleSystemSet } from "../src/particles/node-particle-system-set";
import { ParticleSystem } from "../src/particles/particle-system";
import type { Scene } from "../src/scene/scene";

const parseMock = vi.mocked(parseNodeParticleSetFromSnippet);
const registerMock = vi.mocked(registerNodeParticleSet);
const stopMock = vi.mocked(stopParticleSystem);
const startMock = vi.mocked(startParticleSystem);
const animateMock = vi.mocked(animateParticleSystem);
const createBillboardMock = vi.mocked(createParticleBillboard);
const syncBillboardMock = vi.mocked(syncParticleBillboard);
const addBillboardMock = vi.mocked(addFacingBillboardSystem);

/** Minimal GPU-free stand-ins for the Lite engine/scene contexts a build needs. */
function makeScene(): { scene: Scene; liteScene: object; liteEngine: object; deferred: Array<() => void> } {
    const liteEngine = { id: "engine" };
    const liteScene = { id: "scene" };
    const deferred: Array<() => void> = [];
    const scene = {
        _lite: liteScene,
        getEngine: () => ({ _lite: liteEngine }),
        _deferAdd: (add: () => void) => {
            deferred.push(add);
        },
    } as unknown as Scene;
    return { scene, liteScene, liteEngine, deferred };
}

describe("NodeParticleSystemSet", () => {
    it("Parse(json).buildAsync forwards inline JSON to Lite (BJS defaults, empty snippet id)", async () => {
        parseMock.mockReset();
        const liteSet = { systems: [] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const { scene, liteScene, liteEngine } = makeScene();

        const source = { name: "MyGraph", blocks: [] };
        const graph = NodeParticleSystemSet.Parse(source);
        expect(graph).toBeInstanceOf(NodeParticleSystemSet);
        expect(graph.name).toBe("MyGraph");
        expect(graph.getClassName()).toBe("NodeParticleSystemSet");

        const set = await graph.buildAsync(scene);
        expect(parseMock).toHaveBeenCalledWith(liteEngine, liteScene, "", { json: source });
        expect(set).toBeInstanceOf(ParticleSystemSet);
    });

    it("ParseFromSnippetAsync(id).buildAsync forwards the snippet id with no inline JSON", async () => {
        parseMock.mockReset();
        const liteSet = { systems: [] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const { scene, liteScene, liteEngine } = makeScene();

        const graph = await NodeParticleSystemSet.ParseFromSnippetAsync("#W5054F");
        expect(graph.name).toBe("#W5054F");

        await graph.buildAsync(scene);
        expect(parseMock).toHaveBeenCalledWith(liteEngine, liteScene, "#W5054F", {});
    });

    it("ParseFromSnippetAsync reuses an existing set when passed one", async () => {
        const existing = new NodeParticleSystemSet("existing");
        const result = await NodeParticleSystemSet.ParseFromSnippetAsync("#ABC", existing);
        expect(result).toBe(existing);
        expect(result.name).toBe("#ABC");
    });

    it("throws on the programmatic graph-authoring surface", () => {
        const set = NodeParticleSystemSet.Parse({});
        expect(() => set.getBlockByName("x")).toThrow(LiteCompatError);
        expect(() => set.attachedBlocks).toThrow(LiteCompatError);
        expect(() => set.serialize()).toThrow(LiteCompatError);
        expect(() => set.editAsync()).toThrow(LiteCompatError);
        expect(() => NodeParticleSystemSet.CreateDefault("d")).toThrow(LiteCompatError);
    });
});

describe("ParticleSystemSet", () => {
    it("start() forwards to registerNodeParticleSet with autoStart and is idempotent", async () => {
        parseMock.mockReset();
        registerMock.mockReset();
        const liteSet = { systems: [] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const { scene, liteScene } = makeScene();

        const set = await NodeParticleSystemSet.Parse({}).buildAsync(scene);
        set.start();
        set.start();
        expect(registerMock).toHaveBeenCalledTimes(1);
        expect(registerMock).toHaveBeenCalledWith(liteScene, liteSet, { autoStart: true });
    });

    it("dispose() stops every built system via stopParticleSystem", async () => {
        parseMock.mockReset();
        stopMock.mockReset();
        const s0 = { id: 0 };
        const s1 = { id: 1 };
        const liteSet = { systems: [s0, s1] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const { scene } = makeScene();

        const set = await NodeParticleSystemSet.Parse({}).buildAsync(scene);
        set.dispose();
        expect(stopMock.mock.calls).toEqual([[s0], [s1]]);
    });

    it("a directly-constructed empty set is inert (no systems, no forwarding)", () => {
        registerMock.mockReset();
        stopMock.mockReset();
        const set = new ParticleSystemSet();
        expect(set.getClassName()).toBe("ParticleSystemSet");
        expect(set.systems).toEqual([]);
        set.start();
        set.dispose();
        expect(registerMock).not.toHaveBeenCalled();
        expect(stopMock).not.toHaveBeenCalled();
    });

    it("systems returns stable-identity ParticleSystem wrappers over the built Lite systems", async () => {
        parseMock.mockReset();
        const s0 = { updateSpeed: 0.1, texture: null };
        const liteSet = { systems: [s0] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const { scene } = makeScene();

        const set = await NodeParticleSystemSet.Parse({}).buildAsync(scene);
        const systems = set.systems;
        expect(systems).toHaveLength(1);
        expect(systems[0]).toBeInstanceOf(ParticleSystem);
        expect(systems[0]!.getClassName()).toBe("ParticleSystem");
        // Stable identity across reads.
        expect(set.systems[0]).toBe(systems[0]);
    });
});

describe("ParticleSystem (per-system NPE handle)", () => {
    beforeEach(() => {
        parseMock.mockReset();
        startMock.mockReset();
        animateMock.mockReset();
        stopMock.mockReset();
        createBillboardMock.mockReset();
        createBillboardMock.mockReturnValue({ billboard: true } as never);
        syncBillboardMock.mockReset();
        addBillboardMock.mockReset();
    });

    async function buildOneSystem(lite: object) {
        const liteSet = { systems: [lite] } as unknown as LiteNodeParticleSet;
        parseMock.mockResolvedValueOnce(liteSet);
        const scene = makeScene();
        const set = await NodeParticleSystemSet.Parse({}).buildAsync(scene.scene);
        const system = set.systems[0]!;
        return { system, ...scene };
    }

    it("imperative construction throws (Lite has no graph-authoring API)", () => {
        expect(() => new ParticleSystem()).toThrow(LiteCompatError);
    });

    it("updateSpeed proxies the backing Lite system", async () => {
        const lite = { updateSpeed: 0.0167, texture: null };
        const { system } = await buildOneSystem(lite);
        expect(system.updateSpeed).toBe(0.0167);
        system.updateSpeed = 0;
        expect(lite.updateSpeed).toBe(0);
    });

    it("start() forwards to startParticleSystem once (idempotent)", async () => {
        const lite = { updateSpeed: 0.1, texture: null };
        const { system } = await buildOneSystem(lite);
        system.start();
        system.start();
        expect(startMock).toHaveBeenCalledTimes(1);
        expect(startMock).toHaveBeenCalledWith(lite);
    });

    it("animate() forwards to animateParticleSystem with the parity ratio 1", async () => {
        const lite = { updateSpeed: 0.1, texture: null };
        const { system } = await buildOneSystem(lite);
        system.animate(true);
        system.animate();
        expect(animateMock.mock.calls).toEqual([
            [lite, 1],
            [lite, 1],
        ]);
    });

    it("stop()/dispose() forward to stopParticleSystem", async () => {
        const lite = { updateSpeed: 0.1, texture: null };
        const { system } = await buildOneSystem(lite);
        system.stop();
        system.dispose();
        expect(stopMock.mock.calls).toEqual([[lite], [lite]]);
    });

    it("start() defers a billboard build that binds the loaded texture and renders once", async () => {
        const lite = { updateSpeed: 0.1, texture: null as unknown };
        const { system, scene, liteScene, deferred } = await buildOneSystem(lite);
        // Mirror the ported oracle: assign a (loaded) particle texture, then start.
        const loadedTexture2D = { gpu: "tex" };
        system.particleTexture = { _lite: loadedTexture2D } as never;
        expect(system.particleTexture).not.toBeNull();
        system.start();
        // Nothing rendered until the deferred build runs at engine start.
        expect(createBillboardMock).not.toHaveBeenCalled();
        expect(deferred).toHaveLength(1);

        deferred[0]!();
        expect(lite.texture).toBe(loadedTexture2D);
        expect(createBillboardMock).toHaveBeenCalledWith(lite);
        expect(syncBillboardMock).toHaveBeenCalledWith(lite, { billboard: true });
        expect(addBillboardMock).toHaveBeenCalledWith(liteScene, { billboard: true });
        void scene;
    });

    it("the deferred build skips rendering when no texture is available", async () => {
        const lite = { updateSpeed: 0.1, texture: null as unknown };
        const { system, deferred } = await buildOneSystem(lite);
        system.start();
        deferred[0]!();
        expect(createBillboardMock).not.toHaveBeenCalled();
        expect(addBillboardMock).not.toHaveBeenCalled();
    });
});
