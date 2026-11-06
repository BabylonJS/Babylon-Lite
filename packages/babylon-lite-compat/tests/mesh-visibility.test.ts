import { describe, expect, it, vi } from "vitest";
import { createPbrMaterial, createStandardMaterial, createTransformNode, getMeshOpacity, setMeshOpacity, setPbrAlphaCutoff } from "babylon-lite";
import type { Material, Mesh as LiteMesh, SceneNode } from "babylon-lite";
import { LiteCompatError } from "../src/error";
import { Mesh } from "../src/meshes/meshes";
import { NodeMaterial } from "../src/materials/node-material";
import type { Scene } from "../src/scene/scene";

function liteMesh(name = "visibility-source", material: Material = createStandardMaterial()): LiteMesh {
    const buffer = (): GPUBuffer => ({ destroy: vi.fn() }) as unknown as GPUBuffer;
    const gpu = {
        positionBuffer: buffer(),
        normalBuffer: buffer(),
        uvBuffer: buffer(),
        indexBuffer: buffer(),
        indexCount: 3,
        indexFormat: "uint16",
    };
    return Object.assign(createTransformNode(name), {
        _gpu: gpu,
        material,
        visible: true,
        pickable: true,
    }) as unknown as LiteMesh;
}

function unsupportedMaterial(family: "node" | "shader"): Material {
    return { _buildGroup: Object.assign(vi.fn(), { _materialFamily: family }) } as unknown as Material;
}

function attach(parent: SceneNode, ...children: SceneNode[]): void {
    parent.children.push(...children);
    for (const child of children) {
        child.parent = parent;
    }
}

describe("automatic compat Mesh.visibility", () => {
    it("defaults to 1 without an enabler", () => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        expect(wrapper.visibility).toBe(1);
        expect(getMeshOpacity(lite)).toBe(1);
    });

    it.each([
        [-3, 0],
        [0, 0],
        [0.4, 0.4],
        [1, 1],
        [1.2, 1],
    ])("stores raw finite visibility %s while rendering at %s", (raw, rendered) => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        wrapper.visibility = raw;
        expect(wrapper.visibility).toBe(raw);
        expect(getMeshOpacity(lite)).toBe(rendered);
        expect(Boolean(lite._skipColorDraw)).toBe(rendered === 0);
    });

    it.each([NaN, Infinity, -Infinity])("rejects %s without changing raw or native state", (invalid) => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        wrapper.visibility = 0.4;
        expect(() => {
            wrapper.visibility = invalid;
        }).toThrow(RangeError);
        expect(wrapper.visibility).toBe(0.4);
        expect(getMeshOpacity(lite)).toBe(0.4);
    });

    it("keeps zero independent of isVisible, enabled state, and picking", () => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        wrapper.visibility = 0;
        expect(wrapper.isVisible).toBe(true);
        expect(wrapper.isPickable).toBe(true);
        expect(lite.visible).toBe(true);
        expect(lite._skipColorDraw).toBe(true);
        wrapper.isVisible = false;
        expect(wrapper.visibility).toBe(0);
        wrapper.visibility = 0.5;
        expect(lite._skipColorDraw).toBe(false);
        expect(wrapper.isVisible).toBe(false);
        expect(lite.visible).toBe(false);
        wrapper.isVisible = true;
        wrapper.setEnabled(false);
        wrapper.setEnabled(true);
        expect(wrapper.visibility).toBe(0.5);
        expect(getMeshOpacity(lite)).toBe(0.5);
        expect(wrapper.isVisible).toBe(true);
    });

    it("initializes a loaded wrapper from existing native opacity without replacing its material", () => {
        const lite = liteMesh();
        const material = lite.material;
        setMeshOpacity(lite, 0.6);
        const wrapper = Mesh._fromLite(lite);
        expect(wrapper.visibility).toBe(0.6);
        expect(lite.material).toBe(material);
    });

    it("keeps a loaded material shared with an unfaded twin without changing its alpha", () => {
        const material = createStandardMaterial();
        material.alpha = 0.3;
        const before = { ...material };
        const faded = liteMesh("faded", material);
        const twin = liteMesh("twin", material);
        const fadedWrapper = Mesh._fromLite(faded);
        const twinWrapper = Mesh._fromLite(twin);
        fadedWrapper.visibility = 0.5;
        expect(getMeshOpacity(faded)).toBe(0.5);
        expect(getMeshOpacity(twin)).toBe(1);
        expect(twinWrapper.visibility).toBe(1);
        expect(faded.material).toBe(material);
        expect(twin.material).toBe(material);
        expect(material).toEqual(before);
    });

    it.each(["node", "shader"] as const)("rejects fading a loaded %s material without changing the getter", (family) => {
        const material = unsupportedMaterial(family);
        const lite = liteMesh("unsupported", material);
        const wrapper = Mesh._fromLite(lite);
        expect(() => {
            wrapper.visibility = 0.5;
        }).toThrow(LiteCompatError);
        expect(wrapper.visibility).toBe(1);
        expect(getMeshOpacity(lite)).toBe(1);
        expect(lite.material).toBe(material);
    });

    it.each(["node", "shader"] as const)("rejects a later %s material before compat or native material state changes", (family) => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        const previous = { _lite: lite.material } as unknown as NonNullable<Mesh["material"]>;
        wrapper.material = previous;
        wrapper.visibility = 0.5;
        const unsupported = { _lite: unsupportedMaterial(family) } as unknown as NonNullable<Mesh["material"]>;
        expect(() => {
            wrapper.material = unsupported;
        }).toThrow(LiteCompatError);
        expect(wrapper.material).toBe(previous);
        expect(lite.material).toBe(previous._lite);
        expect(wrapper.visibility).toBe(0.5);
    });

    it("does not propagate visibility to a child mesh", () => {
        const parent = liteMesh("parent");
        const child = liteMesh("child");
        parent.children.push(child);
        child.parent = parent;
        const wrapper = Mesh._fromLiteHierarchy(parent);
        const childWrapper = wrapper.getChildMeshes()[0] as Mesh;
        expect(childWrapper).toBeInstanceOf(Mesh);
        wrapper.visibility = 0.5;
        expect(getMeshOpacity(parent)).toBe(0.5);
        expect(getMeshOpacity(child)).toBe(1);
        expect(childWrapper.visibility).toBe(1);
        expect(childWrapper.isVisible).toBe(true);
    });

    it("fans out only to a glTF node's immediate primitives, preserving shared MASK material and child nodes", () => {
        const material = createPbrMaterial({ alphaBlend: false });
        setPbrAlphaCutoff(material, 0.5);
        const before = { ...material };
        const root = createTransformNode("__root__");
        const owner = createTransformNode("gltf-mesh-node");
        const childNode = createTransformNode("child-gltf-node");
        const primitives = [liteMesh("primitive-a", material), liteMesh("primitive-b", material)];
        const childPrimitive = liteMesh("child-primitive", material);
        attach(root, owner);
        attach(owner, childNode, ...primitives);
        attach(childNode, childPrimitive);
        const rootWrapper = Mesh._fromLiteHierarchy(root as LiteMesh);
        const wrappers = rootWrapper.getChildMeshes();
        const ownerWrapper = wrappers.find((node) => node.name === owner.name) as Mesh;
        const childWrapper = wrappers.find((node) => node.name === childNode.name) as Mesh;
        rootWrapper.visibility = 0.2;
        expect(primitives.map(getMeshOpacity)).toEqual([1, 1]);
        ownerWrapper.visibility = 0.5;
        expect(primitives.map(getMeshOpacity)).toEqual([0.5, 0.5]);
        expect(getMeshOpacity(childPrimitive)).toBe(1);
        expect(childWrapper.visibility).toBe(1);
        expect(primitives.every((primitive) => primitive.material === material)).toBe(true);
        expect(childPrimitive.material).toBe(material);
        expect(material).toEqual(before);
        expect(ownerWrapper.visibility).toBe(0.5);
        expect(ownerWrapper.isVisible).toBe(true);
        const clonedOwner = ownerWrapper.clone("gltf-node-copy");
        expect(clonedOwner.visibility).toBe(0.5);
        expect(clonedOwner._lite.children.filter((node) => "_gpu" in node).map((node) => getMeshOpacity(node as LiteMesh))).toEqual([0.5, 0.5]);
    });

    it("prevalidates every primitive before changing any scalar, material, or raw visibility", () => {
        const owner = createTransformNode("atomic-gltf-node");
        const supported = liteMesh("supported-first");
        const unsupported = liteMesh("unsupported-last", unsupportedMaterial("node"));
        attach(owner, supported, unsupported);
        const wrapper = Mesh._fromLiteHierarchy(owner as LiteMesh);
        const before = [supported, unsupported].map(Object.getOwnPropertyDescriptors);
        expect(() => {
            wrapper.visibility = 0.5;
        }).toThrow(LiteCompatError);
        expect(wrapper.visibility).toBe(1);
        expect([supported, unsupported].map(getMeshOpacity)).toEqual([1, 1]);
        expect([supported, unsupported].map(Object.getOwnPropertyDescriptors)).toEqual(before);
    });

    it("prevalidates a disposed primitive even for a reset to 1", () => {
        const owner = createTransformNode("disposed-gltf-node");
        const first = liteMesh("first");
        const last = liteMesh("last");
        attach(owner, first, last);
        const wrapper = Mesh._fromLiteHierarchy(owner as LiteMesh);
        wrapper.visibility = 0.5;
        Object.assign(last, { _disposed: true });
        expect(() => {
            wrapper.visibility = 1;
        }).toThrow(/last.*disposed/);
        expect(wrapper.visibility).toBe(0.5);
        expect([first, last].map(getMeshOpacity)).toEqual([0.5, 0.5]);
    });

    it("rejects a pending NodeMaterial both before fading and on a faded mesh", () => {
        const pending = new NodeMaterial("not-yet-parsed", {} as Scene);
        const first = Mesh._fromLite(liteMesh("pending-first"));
        const nativeMaterial = first._lite.material;
        first.material = pending;
        expect(pending._lite).toBeUndefined();
        expect(() => {
            first.visibility = 0.5;
        }).toThrow(LiteCompatError);
        expect(first.visibility).toBe(1);
        expect(first._lite.material).toBe(nativeMaterial);
        const second = Mesh._fromLite(liteMesh("faded-first"));
        second.visibility = 0.5;
        expect(() => {
            second.material = pending;
        }).toThrow(LiteCompatError);
        expect(second.material).toBeNull();
        expect(second.visibility).toBe(0.5);
    });

    it.each([-0.5, 0, 0.4, 1.2])("copies raw visibility %s through the real clone path", (raw) => {
        const lite = liteMesh();
        const wrapper = Mesh._fromLite(lite);
        wrapper.visibility = raw;
        const clone = wrapper.clone("visibility-copy");
        expect(clone.visibility).toBe(raw);
        expect(getMeshOpacity(clone._lite)).toBe(getMeshOpacity(lite));
        expect(clone._lite.material).toBe(lite.material);
        expect(clone._lite._skipColorDraw).toBe(lite._skipColorDraw);
        clone.visibility = 0.8;
        expect(clone._lite._skipColorDraw).toBe(false);
        expect(Boolean(lite._skipColorDraw)).toBe(raw <= 0);
        expect(wrapper.visibility).toBe(raw);
        expect(getMeshOpacity(clone._lite)).toBe(0.8);
    });
});
