import { buildNativeMassProperties } from "./havok-mass-properties.js";
import type { PhysicsBody, PhysicsMassProperties, PhysicsWorld } from "./havok.js";

export interface HavokThinInstanceAdvancedContext {
    setShapes(raw: any, handles: any[], scales: Float64Array, shape: any): unknown;
    releaseShapes(raw: any, handles: any[]): void;
    mass(raw: any, body: PhysicsBody, handles: any[], properties: PhysicsMassProperties, fallbackInertia?: number): void;
}

export function enableHavokThinInstanceAdvancedPhysics(world: PhysicsWorld): void {
    const shapesByHandles = new WeakMap<any[], Map<string, any>>();
    const releaseShapes = (raw: any, handles: any[]): void => {
        const shapes = shapesByHandles.get(handles);
        if (shapes) {
            for (const shape of shapes.values()) {
                raw.HP_Shape_Release(shape);
            }
            shapesByHandles.delete(handles);
        }
    };
    world._thinAdvanced = {
        setShapes(raw, handles, scales, shape) {
            const scaledShapes = new Map<string, any>();
            let result;
            for (let index = 0; index < handles.length; index++) {
                const scaleOffset = index * 3;
                const x = scales[scaleOffset]!;
                const y = scales[scaleOffset + 1]!;
                const z = scales[scaleOffset + 2]!;
                let instanceShape = shape;
                if (x !== 1 || y !== 1 || z !== 1) {
                    const key = `${x},${y},${z}`;
                    instanceShape = scaledShapes.get(key);
                    if (!instanceShape) {
                        instanceShape = raw.HP_Shape_CreateContainer()[1];
                        raw.HP_Shape_AddChild(instanceShape, shape, [
                            [0, 0, 0],
                            [0, 0, 0, 1],
                            [x, y, z],
                        ]);
                        scaledShapes.set(key, instanceShape);
                    }
                }
                result = raw.HP_Body_SetShape(handles[index], instanceShape);
            }
            releaseShapes(raw, handles);
            shapesByHandles.set(handles, scaledShapes);
            return result;
        },
        releaseShapes,
        mass(raw, body, handles, properties, fallbackInertia) {
            const transform = body._massPropertiesTransform;
            for (let index = 0; index < handles.length; index++) {
                const massProperties = buildNativeMassProperties(raw, handles[index], properties, fallbackInertia);
                transform?.(massProperties, index);
                raw.HP_Body_SetMassProperties(handles[index], massProperties);
            }
        },
    };
}
