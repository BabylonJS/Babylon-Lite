import { describe, expect, it } from "vitest";

import { Node } from "../src/node/node";
import { Mesh, AbstractMesh, TransformNode } from "../src/meshes/meshes";
import { AbstractEngine, ThinEngine, Engine, WebGPUEngine } from "../src/engine/engine";
import { AbstractScene } from "../src/scene/abstract-scene";
import { Scene } from "../src/scene/scene";

/**
 * The compat layer reproduces the Babylon.js scene-graph inheritance chain
 * (`Mesh → AbstractMesh → TransformNode → Node`). These tests assert the chain
 * and the placement of inherited members without needing a GPU device.
 */
describe("Scene-graph class hierarchy", () => {
    it("reproduces Mesh → AbstractMesh → TransformNode → Node", () => {
        // Prototype-chain assertions don't require a constructed (GPU-backed) mesh.
        expect(Object.getPrototypeOf(Mesh)).toBe(AbstractMesh);
        expect(Object.getPrototypeOf(AbstractMesh)).toBe(TransformNode);
        expect(Object.getPrototypeOf(TransformNode)).toBe(Node);
    });

    it("places getScene on Node (inherited by the whole chain)", () => {
        expect(typeof Node.prototype.getScene).toBe("function");
        // Mesh inherits getScene from Node rather than redefining it.
        expect(Mesh.prototype.getScene).toBe(Node.prototype.getScene);
        expect(AbstractMesh.prototype.getScene).toBe(Node.prototype.getScene);
    });

    it("places transform accessors on TransformNode", () => {
        const descriptor = Object.getOwnPropertyDescriptor(TransformNode.prototype, "position");
        expect(descriptor?.get).toBeTypeOf("function");
        expect(descriptor?.set).toBeTypeOf("function");
    });

    it("reports the Babylon.js class names via getClassName", () => {
        // getClassName is overridden per level; check via prototype invocation.
        expect(Node.prototype.getClassName.call({})).toBe("Node");
        expect(TransformNode.prototype.getClassName.call({})).toBe("TransformNode");
        expect(AbstractMesh.prototype.getClassName.call({})).toBe("AbstractMesh");
        expect(Mesh.prototype.getClassName.call({})).toBe("Mesh");
    });

    it("an adopted instance is instanceof the whole chain", () => {
        // Build a minimal Mesh via the prototype to exercise instanceof wiring
        // without a GPU-backed Lite mesh.
        const mesh = Object.create(Mesh.prototype) as Mesh;
        expect(mesh).toBeInstanceOf(Mesh);
        expect(mesh).toBeInstanceOf(AbstractMesh);
        expect(mesh).toBeInstanceOf(TransformNode);
        expect(mesh).toBeInstanceOf(Node);
    });
});

describe("Engine class hierarchy", () => {
    it("mirrors Babylon.js: ThinEngine → AbstractEngine and Engine → ThinEngine", () => {
        expect(Object.getPrototypeOf(ThinEngine)).toBe(AbstractEngine);
        expect(Object.getPrototypeOf(Engine)).toBe(ThinEngine);
    });

    it("mirrors Babylon.js: WebGPUEngine → AbstractEngine (sibling of Engine)", () => {
        expect(Object.getPrototypeOf(WebGPUEngine)).toBe(AbstractEngine);
        // Engine and WebGPUEngine are siblings — neither inherits from the other.
        expect(Object.getPrototypeOf(WebGPUEngine)).not.toBe(Engine);
    });

    it("an Engine is an AbstractEngine/ThinEngine but not a WebGPUEngine", () => {
        const engine = Object.create(Engine.prototype) as Engine;
        expect(engine).toBeInstanceOf(Engine);
        expect(engine).toBeInstanceOf(ThinEngine);
        expect(engine).toBeInstanceOf(AbstractEngine);
        expect(engine).not.toBeInstanceOf(WebGPUEngine);
    });

    it("a WebGPUEngine is an AbstractEngine but not a ThinEngine/Engine", () => {
        const engine = Object.create(WebGPUEngine.prototype) as WebGPUEngine;
        expect(engine).toBeInstanceOf(WebGPUEngine);
        expect(engine).toBeInstanceOf(AbstractEngine);
        expect(engine).not.toBeInstanceOf(ThinEngine);
        expect(engine).not.toBeInstanceOf(Engine);
    });
});

describe("Scene class hierarchy", () => {
    it("mirrors Babylon.js: Scene → AbstractScene", () => {
        expect(Object.getPrototypeOf(Scene)).toBe(AbstractScene);
    });

    it("a Scene is an AbstractScene", () => {
        const scene = Object.create(Scene.prototype) as Scene;
        expect(scene).toBeInstanceOf(Scene);
        expect(scene).toBeInstanceOf(AbstractScene);
    });

    it("places the entity-collection accessors on AbstractScene", () => {
        // cameras/lights/materials/meshes are inherited from AbstractScene, not Scene.
        for (const accessor of ["cameras", "lights", "materials", "meshes"]) {
            expect(Object.getOwnPropertyDescriptor(AbstractScene.prototype, accessor)?.get).toBeTypeOf("function");
            expect(Object.getOwnPropertyDescriptor(Scene.prototype, accessor)).toBeUndefined();
        }
        // getMeshByName / getNodeByName / getXByName lookups live on AbstractScene too.
        expect(AbstractScene.prototype.getMeshByName).toBeTypeOf("function");
        expect(Scene.prototype.getMeshByName).toBe(AbstractScene.prototype.getMeshByName);
    });
});
