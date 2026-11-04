import { describe, expect, it } from "vitest";
import { attach, createScene, expectClose, exportAndParse, loaderRoot, reloadUntexturedGlb, rotate, setParent } from "./export-test-utils";
import { createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera";
import { createPointLight } from "../../../../packages/babylon-lite/src/light/point-light";
import { createDirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import type { DirectionalLight } from "../../../../packages/babylon-lite/src/light/directional-light";
import { createSpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import type { SpotLight } from "../../../../packages/babylon-lite/src/light/spot-light";
import { createHemisphericLight } from "../../../../packages/babylon-lite/src/light/hemispheric";
import { writeWorldLightDirection } from "../../../../packages/babylon-lite/src/light/light-base";

describe("lights", () => {
    it("exports point and directional state, normalizing HDR color into intensity", async () => {
        const point = createPointLight([1, 2, 3], 3);
        point.name = "lamp";
        point.diffuse = [4, 2, 1];
        point.range = 12;
        const directional = createDirectionalLight([1, 0, 0], 0.2);
        directional.diffuse = [1, 0, 0];
        const white = createDirectionalLight([0, -1, 0]);
        white.diffuse = [2, 2, 2];
        const glb = await exportAndParse(createScene({ lights: [point, directional, white] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights).toEqual([
            { name: "lamp", type: "point", color: [1, 0.5, 0.25], intensity: 12, range: 12 },
            { type: "directional", color: [1, 0, 0], intensity: 0.2 },
            { type: "directional", intensity: 2 },
        ]);
        expect(glb.json.nodes[0]).toMatchObject({ translation: [-1, 2, 3], extensions: { KHR_lights_punctual: { light: 0 } } });
        expectClose(rotate(glb.json.nodes[1].rotation, [0, 0, -1]), [-1, 0, 0]);
        expect(glb.json.extensionsUsed).toEqual(["KHR_lights_punctual"]);
        expect(glb.json.extensionsRequired).toBeUndefined();
    });

    it.each([
        { angle: Math.PI / 2, outer: undefined, warning: undefined },
        { angle: 4, outer: Math.PI / 2, warning: "cone wider" },
        { angle: 0, outer: 1e-4, warning: "empty cone" },
        { angle: Number.NaN, outer: 1e-4, warning: "empty cone" },
        { angle: 2e-4, outer: 1e-4, warning: undefined },
    ])("bounds spot cone angles without hiding the minimum boundary ($angle)", async ({ angle, outer, warning }) => {
        const glb = await exportAndParse(createScene({ lights: [createSpotLight([0, 0, 0], [0, 0, -1], angle, 1)] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights[0].spot.outerConeAngle).toBe(outer);
        expect(warning ? glb.warnings.some((text) => text.includes(warning)) : glb.warnings.length === 0).toBe(true);
    });

    it("warns about unsupported hemispheric lighting and exponent falloff", async () => {
        const glb = await exportAndParse(createScene({ lights: [createHemisphericLight(), createSpotLight([0, 0, 0], [0, 0, -1], 1, 2)] }));
        expect(glb.json.extensions.KHR_lights_punctual.lights).toHaveLength(1);
        expect(glb.warnings).toEqual([
            "Hemispheric light is not representable in KHR_lights_punctual; skipping.",
            "Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.",
        ]);
    });

    describe.each([false, true])("scaled parented lights (pass-through: %s)", (passThrough) => {
        it.each([
            ["directional", "mirrored"],
            ["spot", "mirrored"],
            ["directional", "non-uniform"],
            ["spot", "non-uniform"],
        ] as const)("round-trips a %s light with %s local scale", async (type, scale) => {
            const holder = createTransformNode("holder", 1, 2, 3, 0, 0, Math.sin(0.2), Math.cos(0.2), 2, 3, 1);
            if (passThrough) {
                attach(holder, loaderRoot());
            }
            const direction: [number, number, number] = scale === "mirrored" ? [0, 0, -1] : [1, 1, -1];
            const light = type === "directional" ? createDirectionalLight(direction) : createSpotLight([0, 0, 0], direction, 1, 1);
            if (scale === "mirrored") {
                light.scaling.z = -1;
            } else {
                light.scaling.set(2, 3, 4);
                light.rotationQuaternion.y = Math.sin(0.3);
                light.rotationQuaternion.w = Math.cos(0.3);
            }
            setParent(light, holder);
            const before = new Float32Array(3);
            writeWorldLightDirection(before, 0, light.worldMatrix, light.direction);
            const glb = await exportAndParse(createScene({ lights: [light] }));
            expect(glb.json.nodes).toHaveLength(2);
            expect(glb.json.nodes[0].extensions).toBeUndefined();
            const container = await reloadUntexturedGlb(glb);
            const reloaded = container.entities.find(
                (entity): entity is DirectionalLight | SpotLight => "lightType" in entity && (entity.lightType === "directional" || entity.lightType === "spot")
            )!;
            const after = new Float32Array(3);
            writeWorldLightDirection(after, 0, reloaded.worldMatrix, reloaded.direction);
            expectClose(after, Array.from(before), 6);
        });
    });

    it.each(["camera", "light"])("places a light with an exported %s parent at its world transform, not under that glTF node", async (kind) => {
        const camera = createFreeCamera({ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 1 });
        const parentLight = createPointLight([5, 0, 0]);
        const child = createPointLight([0, 2, 0]);
        setParent(child, kind === "camera" ? camera : parentLight);
        const glb = await exportAndParse(createScene({ lights: kind === "camera" ? [child] : [parentLight, child], camera: kind === "camera" ? camera : undefined }));
        const lightIndex = kind === "camera" ? 0 : 1;
        const node = glb.json.nodes.find((node: { extensions?: { KHR_lights_punctual?: { light: number } } }) => node.extensions?.KHR_lights_punctual?.light === lightIndex);
        expectClose(node.translation, [-5, 2, 0]);
        expect(glb.json.scenes[0].nodes).toEqual([0, 1]);
        expect(glb.json.nodes.every((node: { children?: number[] }) => node.children === undefined)).toBe(true);
    });

    it.each(["float noise", "small translation", "small direction"])("collapses only identity-like lights (%s)", async (kind) => {
        const holder = createTransformNode("holder");
        const light = kind === "small direction" ? createDirectionalLight([0.0005, 0, -1]) : createPointLight([kind === "float noise" ? 1e-12 : 0.0005, 0, 0]);
        setParent(light, holder);
        const glb = await exportAndParse(createScene({ lights: [light] }));
        expect(glb.json.nodes).toHaveLength(kind === "float noise" ? 1 : 2);
        if (kind === "small translation") {
            expectClose(glb.json.nodes[1].translation, [-0.0005, 0, 0]);
        } else if (kind === "small direction") {
            expect(glb.json.nodes[1].rotation).toBeDefined();
        } else {
            expect(glb.json.nodes[0].extensions.KHR_lights_punctual.light).toBe(0);
        }
    });

    it("never collapses two lights onto one node", async () => {
        const holder = createTransformNode("holder");
        const lights = [createPointLight([0, 0, 0]), createPointLight([0, 0, 0])];
        for (const light of lights) {
            setParent(light, holder);
        }
        const glb = await exportAndParse(createScene({ lights }));
        expect(glb.json.nodes).toHaveLength(2);
        expect(glb.json.nodes[0].children).toEqual([1]);
        expect(glb.json.nodes.map((node: { extensions: { KHR_lights_punctual: { light: number } } }) => node.extensions.KHR_lights_punctual.light)).toEqual([0, 1]);
    });
});
