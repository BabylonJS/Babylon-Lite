import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, rotate, setParent } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import type { SceneNode } from "../../../../packages/babylon-lite/src/scene/scene-node";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { enableOrthographicCamera } from "../../../../packages/babylon-lite/src/camera/orthographic";

describe("camera", () => {
    const lookingAlongZ = () => createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    it.each([
        { far: 500, width: 800, height: 400, zfar: 500, aspectRatio: 2 },
        { far: 999999, width: 0, height: 400, zfar: 999999, aspectRatio: undefined },
        { far: 1e6, width: 800, height: 0, zfar: undefined, aspectRatio: undefined },
        { far: 2, width: -10, height: 400, zfar: undefined, aspectRatio: undefined },
        { far: Number.NaN, width: 0, height: 0, zfar: undefined, aspectRatio: undefined },
    ])("exports perspective fields with valid far/aspect bounds ($far, $width × $height)", async ({ far, width, height, zfar, aspectRatio }) => {
        const camera = lookingAlongZ();
        camera.name = "main";
        camera.fov = 0.5;
        camera.nearPlane = 2;
        camera.farPlane = far;
        const glb = await exportAndParse(createScene({ camera, canvas: { width, height } }));
        expect(glb.json.cameras[0]).toMatchObject({ name: "main", type: "perspective", perspective: { yfov: 0.5, znear: 2 } });
        expect(glb.json.cameras[0].perspective.zfar).toBe(zfar);
        expect(glb.json.cameras[0].perspective.aspectRatio).toBe(aspectRatio);
    });

    it.each([
        { projection: { left: -4, right: 4, bottom: -2, top: 2 }, canvas: undefined, xmag: 4, ymag: 2, warning: undefined },
        { projection: { left: -1, right: 3, bottom: -2, top: 2 }, canvas: undefined, xmag: 2, ymag: 2, warning: "off-center bounds" },
        { projection: { halfHeight: 3 }, canvas: { width: 800, height: 400 }, xmag: 6, ymag: 3, warning: undefined },
        { projection: { halfHeight: 3 }, canvas: undefined, xmag: 3, ymag: 3, warning: "aspect is unavailable" },
    ])("exports orthographic forms and documented fallbacks ($xmag, $ymag)", async ({ projection, canvas, xmag, ymag, warning }) => {
        const camera = lookingAlongZ();
        camera.nearPlane = 0.5;
        camera.farPlane = 80;
        enableOrthographicCamera(camera, projection);
        const glb = await exportAndParse(createScene({ camera, canvas }));
        expect(glb.json.cameras[0]).toEqual({ type: "orthographic", orthographic: { xmag, ymag, znear: 0.5, zfar: 80 } });
        expect(warning ? glb.warnings.some((text) => text.includes(warning)) : glb.warnings.length === 0).toBe(true);
    });

    it.each([
        ["+Z", 0, 0, 1, [0, 0, 1]],
        ["-Z", 0, 0, -1, [0, 0, -1]],
        ["+X", 1, 0, 0, [-1, 0, 0]],
        ["-X", -1, 0, 0, [1, 0, 0]],
        ["pitched", 0, 1, 1, [0, Math.SQRT1_2, Math.SQRT1_2]],
    ] as const)("keeps a small translation and the converting %s view", async (_name, x, y, z, direction) => {
        const camera = createFreeCamera({ x: 0.0005, y: 0, z: 0 }, { x: 0.0005 + x, y, z });
        const glb = await exportAndParse(createScene({ camera }));
        expectClose(rotate(glb.json.nodes[0].rotation ?? [0, 0, 0, 1], [0, 0, -1]), direction);
        expectClose(glb.json.nodes[0].translation, [-0.0005, 0, 0]);
        expect(glb.json.cameras[0].perspective.aspectRatio).toBeUndefined();
    });

    it.each(["pristine", "residual", "unparented"])("strips a %s camera fixup without losing placement", async (kind) => {
        const holder = createTransformNode("holder");
        const fixup = createTransformNode("cam_fixup", kind === "residual" ? 1 : 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const mesh = attach(createMesh("m"), holder);
        if (kind !== "unparented") {
            attach(fixup, holder);
        }
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
        setParent(camera, fixup);
        const glb = await exportAndParse(createScene({ meshes: kind === "unparented" ? [] : [mesh], camera }));
        expect(glb.json.nodes.map((node: { name: string }) => node.name)).not.toContain("cam_fixup");
        const index = kind === "residual" ? 1 : 0;
        expect(glb.json.nodes[index].camera).toBe(0);
        expect(glb.json.nodes).toHaveLength(index + 1);
        if (kind === "residual") {
            expect(glb.json.nodes[0].children).toEqual([1]);
            expect(glb.json.nodes[0].camera).toBeUndefined();
            expect(glb.warnings).toContain('Camera fixup node "cam_fixup" carries extra transform; exporting the camera as its own node.');
        } else {
            expect(glb.json.scenes[0].nodes).toEqual([0]);
            expect(glb.warnings).toEqual(kind === "unparented" ? ['Camera "" has a mirrored view under its parent; exporting it unmirrored.'] : []);
            const node = glb.json.nodes[0];
            expect(node.scale).toBeUndefined();
            expectClose(rotate(node.rotation ?? [0, 0, 0, 1], [0, 0, -1]), [0, 0, -1]);
            expectClose(rotate(node.rotation ?? [0, 0, 0, 1], [0, 1, 0]), [0, 1, 0]);
        }
    });

    it.each([false, true])("keeps pristine fixup collapse only in the source glTF frame (pass-through: %s)", async (passThrough) => {
        const root = loaderRoot();
        if (!passThrough) {
            attach(root, createTransformNode("app"));
        }
        const holder = attach(createTransformNode("holder", 0, 1, 0, 0, 0, 0, 1, passThrough ? -1 : 1, 1, 1), root);
        const mesh = attach(createMesh("m"), holder);
        const fixup = attach(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1), holder);
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
        setParent(camera, fixup);
        const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
        const index = glb.json.nodes.findIndex((node: { camera?: number }) => node.camera === 0);
        if (passThrough) {
            expect(glb.json.nodes[index].name).toBe("holder");
            expect(glb.warnings).toEqual([]);
        } else {
            expect(glb.warnings).toContain('Camera parent "holder" has a mirrored glTF frame; exporting the camera as a scene root.');
            expect(glb.json.scenes[0].nodes).toContain(index);
            expect(glb.json.nodes[index].scale).toBeUndefined();
            const world = camera.worldMatrix;
            expectClose(glb.json.nodes[index].translation, [-world[12]!, world[13]!, world[14]!]);
        }
    });

    it("unmirrors a camera dropped from a mirrored converting parent, keeping forward and up", async () => {
        const parent = createTransformNode("mirror", 0, 1, 0, 0, 0, 0, 1, -1, 1, 1);
        const mesh = attach(createMesh("m"), parent);
        const camera = lookingAlongZ();
        setParent(camera, parent);
        parent.children.push(camera as unknown as SceneNode);
        const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
        expect(glb.warnings).toContain('Camera parent "mirror" has a mirrored glTF frame; exporting the camera as a scene root.');
        expect(glb.warnings).toContain('Camera "" has a mirrored view under its parent; exporting it unmirrored.');
        const node = glb.json.nodes.find((node: { camera?: number }) => node.camera === 0);
        expectClose(rotate(node.rotation ?? [0, 0, 0, 1], [0, 1, 0]), [0, 1, 0]);
        expectClose(rotate(node.rotation ?? [0, 0, 0, 1], [0, 0, -1]), [0, 0, 1]);
    });
});
