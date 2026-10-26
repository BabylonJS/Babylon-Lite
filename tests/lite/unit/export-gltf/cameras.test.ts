import { describe, expect, it } from "vitest";
import { attach, createMesh, createScene, expectClose, exportAndParse, loaderRoot, rotate, setParent } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import type { SceneNode } from "../../../../packages/babylon-lite/src/scene/scene-node";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { enableOrthographicCamera } from "../../../../packages/babylon-lite/src/camera/orthographic";

describe("camera", () => {
    const lookingAlongZ = () => createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    it("exports perspective yfov, znear and zfar", async () => {
        const camera = lookingAlongZ();
        camera.fov = 0.5;
        camera.nearPlane = 0.25;
        camera.farPlane = 500;
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras).toEqual([{ type: "perspective", perspective: { yfov: 0.5, znear: 0.25, zfar: 500 } }]);
        expect(glb.json.nodes[0].camera).toBe(0);
        expect(glb.json.scenes[0].nodes).toEqual([0]);
    });

    it("names the camera and its node", async () => {
        const camera = lookingAlongZ();
        camera.name = "main";
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].name).toBe("main");
        expect(glb.json.nodes[0].name).toBe("main");
    });

    it("omits zfar when farPlane is at least 1e6", async () => {
        const camera = lookingAlongZ();
        camera.farPlane = 1e6;
        const atSentinel = await exportAndParse(createScene({ camera }));
        expect(atSentinel.json.cameras[0].perspective.zfar).toBeUndefined();
        camera.farPlane = 5e6;
        const above = await exportAndParse(createScene({ camera }));
        expect(above.json.cameras[0].perspective.zfar).toBeUndefined();
        camera.farPlane = 999999;
        const below = await exportAndParse(createScene({ camera }));
        expect(below.json.cameras[0].perspective.zfar).toBe(999999);
    });

    it("derives aspectRatio from the canvas and omits it without one", async () => {
        const camera = lookingAlongZ();
        const withCanvas = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 400 } }));
        expect(withCanvas.json.cameras[0].perspective.aspectRatio).toBe(2);
        const without = await exportAndParse(createScene({ camera }));
        expect(without.json.cameras[0].perspective.aspectRatio).toBeUndefined();
        const zeroHeight = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 0 } }));
        expect(zeroHeight.json.cameras[0].perspective.aspectRatio).toBeUndefined();
    });

    it("omits aspectRatio unless both canvas dimensions are positive", async () => {
        const camera = lookingAlongZ();
        for (const canvas of [
            { width: 0, height: 400 },
            { width: 800, height: 0 },
            { width: 0, height: 0 },
            { width: -10, height: 400 },
        ]) {
            const glb = await exportAndParse(createScene({ camera, canvas }));
            expect(glb.json.cameras[0].perspective.aspectRatio).toBeUndefined();
        }
        const ok = await exportAndParse(createScene({ camera, canvas: { width: 300, height: 100 } }));
        expect(ok.json.cameras[0].perspective.aspectRatio).toBe(3);
    });

    it("omits zfar unless nearPlane < farPlane < 1e6", async () => {
        const camera = lookingAlongZ();
        camera.nearPlane = 2;
        for (const far of [2, 1, -5, Number.NaN, Infinity]) {
            camera.farPlane = far;
            const glb = await exportAndParse(createScene({ camera }));
            expect(glb.json.cameras[0].perspective.zfar, `farPlane ${far}`).toBeUndefined();
        }
        camera.farPlane = 2.5;
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].perspective.zfar).toBe(2.5);
    });

    it("keeps a small real camera translation", async () => {
        const camera = createFreeCamera({ x: 0.0005, y: 0, z: 0 }, { x: 0.0005, y: 0, z: 1 });
        const glb = await exportAndParse(createScene({ camera }));
        expectClose(glb.json.nodes[0].translation, [-0.0005, 0, 0]);
    });

    it("exports the orthographic plane form", async () => {
        const camera = lookingAlongZ();
        camera.nearPlane = 0.5;
        camera.farPlane = 80;
        enableOrthographicCamera(camera, { left: -4, right: 4, bottom: -2, top: 2 });
        const glb = await exportAndParse(createScene({ camera, canvas: { width: 100, height: 100 } }));
        expect(glb.json.cameras[0]).toEqual({ type: "orthographic", orthographic: { xmag: 4, ymag: 2, znear: 0.5, zfar: 80 } });
        expect(glb.warnings).toEqual([]);
    });

    it("derives the orthographic halfHeight form from the canvas aspect", async () => {
        const camera = lookingAlongZ();
        enableOrthographicCamera(camera, { halfHeight: 3 });
        const glb = await exportAndParse(createScene({ camera, canvas: { width: 800, height: 400 } }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 6, ymag: 3 });
        expect(glb.warnings).toEqual([]);
    });

    it("warns and exports xmag = ymag for a halfHeight orthographic camera without a canvas", async () => {
        const camera = lookingAlongZ();
        enableOrthographicCamera(camera, { halfHeight: 3 });
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 3, ymag: 3 });
        expect(glb.warnings).toContain("Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.");
    });

    it("warns about off-center orthographic bounds and exports a symmetric projection", async () => {
        const camera = lookingAlongZ();
        camera.name = "ortho";
        enableOrthographicCamera(camera, { left: -1, right: 3, bottom: -2, top: 2 });
        const glb = await exportAndParse(createScene({ camera }));
        expect(glb.json.cameras[0].orthographic).toMatchObject({ xmag: 2, ymag: 2 });
        expect(glb.warnings).toContain('Orthographic camera "ortho" has off-center bounds; exporting a symmetric projection.');
    });

    it("places a converting camera so it looks along the right-handed image of its Lite view direction", async () => {
        // Lite is left-handed: looking along +Z stays +Z after the X mirror; looking along +X becomes -X.
        const cases: { name: string; position: [number, number, number]; target: [number, number, number]; direction: number[] }[] = [
            { name: "+Z", position: [0, 0, 0], target: [0, 0, 1], direction: [0, 0, 1] },
            { name: "-Z", position: [0, 0, 0], target: [0, 0, -1], direction: [0, 0, -1] },
            { name: "+X", position: [1, 2, 3], target: [2, 2, 3], direction: [-1, 0, 0] },
            { name: "-X", position: [1, 2, 3], target: [0, 2, 3], direction: [1, 0, 0] },
            { name: "pitched up", position: [0, 0, 0], target: [0, 1, 1], direction: [0, Math.SQRT1_2, Math.SQRT1_2] },
        ];
        for (const c of cases) {
            const camera = createFreeCamera({ x: c.position[0], y: c.position[1], z: c.position[2] }, { x: c.target[0], y: c.target[1], z: c.target[2] });
            const glb = await exportAndParse(createScene({ camera }));
            const node = glb.json.nodes[0];
            const rotation = node.rotation ?? [0, 0, 0, 1];
            const view = rotate(rotation, [0, 0, -1]);
            expectClose(view, c.direction);
            expectClose(node.translation ?? [0, 0, 0], [-c.position[0], c.position[1], c.position[2]]);
        }
    });

    it("applies Rotate180Y to a camera at the origin looking along +Z", async () => {
        const glb = await exportAndParse(createScene({ camera: lookingAlongZ() }));
        // A camera node with identity rotation would look along -Z; looking along +Z needs a 180 degree yaw.
        expectClose(glb.json.nodes[0].rotation, [0, 1, 0, 0]);
        expect(glb.json.nodes[0].translation).toBeUndefined();
    });

    describe("fixup nodes", () => {
        function fixupScene(fixup: SceneNode) {
            const holder = createTransformNode("holder");
            const mesh = attach(createMesh("m"), holder);
            attach(fixup, holder);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            return { camera, scene: createScene({ meshes: [mesh], camera }) };
        }

        it("collapses a camera under a pristine fixup onto the fixup's parent node", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.json.nodes).toHaveLength(1);
            expect(glb.json.nodes[0].name).toBe("holder");
            expect(glb.json.nodes[0].camera).toBe(0);
            expect(glb.json.nodes[0].rotation).toBeUndefined();
            expect(glb.json.nodes[0].translation).toBeUndefined();
            expect(glb.json.cameras).toHaveLength(1);
            expect(glb.warnings).toEqual([]);
        });

        it("never exports the fixup node itself", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.json.nodes.map((n: { name: string }) => n.name)).not.toContain("cam_fixup");
        });

        it("warns and gives a camera its own node when the fixup carries a translation", async () => {
            const { scene } = fixupScene(createTransformNode("cam_fixup", 1, 0, 0, 0, 0, 0, 1, -1, 1, 1));
            const glb = await exportAndParse(scene);
            expect(glb.warnings).toContain('Camera fixup node "cam_fixup" carries extra transform; exporting the camera as its own node.');
            expect(glb.json.nodes).toHaveLength(2);
            expect(glb.json.nodes[0].camera).toBeUndefined();
            expect(glb.json.nodes[0].children).toEqual([1]);
            expect(glb.json.nodes[1].camera).toBe(0);
        });

        it("does not collapse onto a parent whose glTF frame is mirrored (a loader root kept under an app node)", async () => {
            const app = createTransformNode("app");
            const root = attach(loaderRoot(), app);
            const holder = attach(createTransformNode("holder", 0, 1, 0), root);
            const mesh = attach(createMesh("m"), holder);
            const fixup = attach(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1), holder);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
            expect(glb.warnings).toContain('Camera parent "holder" has a mirrored glTF frame; exporting the camera as a scene root.');
            const cameraNode = glb.json.nodes.findIndex((n: { camera?: number }) => n.camera === 0);
            expect(glb.json.nodes[cameraNode].name).not.toBe("holder");
            expect(glb.json.scenes[0].nodes).toContain(cameraNode);
            // A scene-root camera node is a pure TRS without scale, so its global basis is proper (det +1).
            expect(glb.json.nodes[cameraNode].scale).toBeUndefined();
            const w = camera.worldMatrix as unknown as number[];
            expectClose(glb.json.nodes[cameraNode].translation, [-w[12]!, w[13]!, w[14]!]);
        });

        it("keeps the pristine collapse onto a mirrored node from the source glTF (under a stripped loader root)", async () => {
            const root = loaderRoot();
            const holder = attach(createTransformNode("holder", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1), root);
            const mesh = attach(createMesh("m"), holder);
            const fixup = attach(createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1), holder);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
            expect(glb.warnings).toEqual([]);
            expect(glb.json.nodes[0].name).toBe("holder");
            expect(glb.json.nodes[0].camera).toBe(0);
        });

        it("unmirrors a camera dropped from a mirrored converting parent, keeping its forward and up", async () => {
            // Translated, so it is not the loader-root shape and exports as a converting node.
            const parent = createTransformNode("mirror", 0, 1, 0, 0, 0, 0, 1, -1, 1, 1);
            const mesh = attach(createMesh("m"), parent);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
            setParent(camera, parent);
            parent.children.push(camera as unknown as SceneNode);
            const glb = await exportAndParse(createScene({ meshes: [mesh], camera }));
            expect(glb.warnings).toContain('Camera parent "mirror" has a mirrored glTF frame; exporting the camera as a scene root.');
            expect(glb.warnings).toContain('Camera "" has a mirrored view under its parent; exporting it unmirrored.');
            const node = glb.json.nodes.find((n: { camera?: number }) => n.camera === 0);
            const q = node.rotation ?? [0, 0, 0, 1];
            // The Lite view looks along world +Z with +Y up; handedness conversion keeps both directions, and a
            // glTF camera looks along its local -Z.
            expectClose(rotate(q, [0, 1, 0]), [0, 1, 0]);
            expectClose(rotate(q, [0, 0, -1]), [0, 0, 1]);
        });

        it("exports a camera under a fixup with no exported parent as its own scene root", async () => {
            const fixup = createTransformNode("cam_fixup", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
            setParent(camera, fixup);
            const glb = await exportAndParse(createScene({ camera }));
            expect(glb.json.nodes).toHaveLength(1);
            expect(glb.json.nodes[0].camera).toBe(0);
            expect(glb.json.scenes[0].nodes).toEqual([0]);
        });
    });
});
