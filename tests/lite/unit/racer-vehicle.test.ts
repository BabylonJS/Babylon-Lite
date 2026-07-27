import { describe, expect, it, vi } from "vitest";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { TransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";

vi.mock("babylon-lite", () => ({ addToScene: vi.fn(), getContainerMeshes: vi.fn(), loadGltf: vi.fn() }));

interface TestVehicle {
    readonly root: TransformNode;
    readonly body: TransformNode | null;
    readonly bodyRestY: number;
    readonly wheels: {
        readonly frontLeft: TransformNode | null;
        readonly frontRight: TransformNode | null;
        readonly backLeft: TransformNode | null;
        readonly backRight: TransformNode | null;
    };
    readonly meshes: readonly Mesh[];
    readonly motorcycle: boolean;
}

interface TestVehicleController {
    tick(dt: number, axes: { steer: number; throttle: number }): void;
    setVehicle(vehicle: TestVehicle): void;
}

interface VehicleControllerModule {
    VehicleController: new (vehicle: TestVehicle) => TestVehicleController;
}

function makeVehicle(bodyY: number): TestVehicle {
    const root = createTransformNode("vehicle");
    const body = createTransformNode("body");
    body.position.y = bodyY;
    body.parent = root;
    root.children.push(body);
    return {
        root,
        body,
        bodyRestY: bodyY,
        wheels: { frontLeft: null, frontRight: null, backLeft: null, backRight: null },
        meshes: [],
        motorcycle: false,
    };
}

describe("VehicleController", () => {
    it("does not accumulate body height when the same vehicle is reselected", async () => {
        // Keep this import non-literal so the tests TypeScript project does not
        // recursively typecheck the demo's package-subpath imports; Vitest still
        // loads and exercises the real controller at runtime.
        const vehicleModule = "../../../lab/lite/src/demos/racer/vehicle.js";
        const { VehicleController } = (await import(vehicleModule)) as VehicleControllerModule;
        const vehicle = makeVehicle(0.4);
        const controller = new VehicleController(vehicle);

        controller.tick(1, { steer: 0, throttle: 0 });
        expect(vehicle.body?.position.y).toBeCloseTo(0.45);

        for (let i = 0; i < 10; i++) {
            controller.setVehicle(vehicle);
            controller.tick(1, { steer: 0, throttle: 0 });
        }

        expect(vehicle.body?.position.y).toBeCloseTo(0.45);
        expect(vehicle.bodyRestY).toBe(0.4);
    }, 15_000);
});
