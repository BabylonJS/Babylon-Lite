import { describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        parseNodeParticleSetFromSnippet: vi.fn(),
        registerNodeParticleSet: vi.fn(),
        stopParticleSystem: vi.fn(),
    };
});

import { parseNodeParticleSetFromSnippet, registerNodeParticleSet, stopParticleSystem } from "babylon-lite";
import type { NodeParticleSet as LiteNodeParticleSet } from "babylon-lite";

import { LiteCompatError } from "../src/error";
import { NodeParticleSystemSet, ParticleSystemSet } from "../src/particles/node-particle-system-set";
import type { Scene } from "../src/scene/scene";

const parseMock = vi.mocked(parseNodeParticleSetFromSnippet);
const registerMock = vi.mocked(registerNodeParticleSet);
const stopMock = vi.mocked(stopParticleSystem);

/** Minimal GPU-free stand-ins for the Lite engine/scene contexts a build needs. */
function makeScene(): { scene: Scene; liteScene: object; liteEngine: object } {
    const liteEngine = { id: "engine" };
    const liteScene = { id: "scene" };
    const scene = {
        _lite: liteScene,
        getEngine: () => ({ _lite: liteEngine }),
    } as unknown as Scene;
    return { scene, liteScene, liteEngine };
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
        set.start();
        set.dispose();
        expect(registerMock).not.toHaveBeenCalled();
        expect(stopMock).not.toHaveBeenCalled();
    });

    it("throws on the unbacked per-system handle accessor", () => {
        const set = new ParticleSystemSet();
        expect(() => set.systems).toThrow(LiteCompatError);
    });
});
