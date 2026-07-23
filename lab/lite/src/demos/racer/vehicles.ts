/**
 * Racer vehicle garage — loads every kit vehicle once and toggles which one is
 * visible, so selecting a car is instant (no reload/dispose). The four trucks
 * share a body; the motorcycle is a separate model (and uses its own engine sound).
 */

import type { EngineContext, SceneContext } from "babylon-lite";

import { loadVehicle, type Vehicle } from "./vehicle.js";

/** A selectable vehicle: display name, model URL, and whether it's the motorcycle. */
export interface VehicleDef {
    name: string;
    url: string;
    motorcycle: boolean;
}

/** Kit vehicles, in selection order (index 0 is the default). */
export const VEHICLES: readonly VehicleDef[] = [
    { name: "Yellow", url: "./racer/models/vehicle-truck-yellow.glb", motorcycle: false },
    { name: "Green", url: "./racer/models/vehicle-truck-green.glb", motorcycle: false },
    { name: "Red", url: "./racer/models/vehicle-truck-red.glb", motorcycle: false },
    { name: "Purple", url: "./racer/models/vehicle-truck-purple.glb", motorcycle: false },
    { name: "Moto", url: "./racer/models/vehicle-motorcycle.glb", motorcycle: true },
];

/** Holds every loaded vehicle and shows one at a time. */
export class VehicleGarage {
    private readonly _vehicles: readonly Vehicle[];
    private _index = 0;

    private constructor(vehicles: readonly Vehicle[]) {
        this._vehicles = vehicles;
        for (let i = 1; i < vehicles.length; i++) {
            this._park(vehicles[i]!);
        }
    }

    /** Load all vehicles (in parallel) and hide all but the default. */
    static async load(engine: EngineContext, scene: SceneContext, resolveUrl: (url: string) => string): Promise<VehicleGarage> {
        const vehicles = await Promise.all(VEHICLES.map((d) => loadVehicle(engine, scene, resolveUrl(d.url), d.motorcycle)));
        return new VehicleGarage(vehicles);
    }

    /** The currently-visible vehicle. */
    get current(): Vehicle {
        return this._vehicles[this._index]!;
    }

    /** Switch the visible vehicle and return it with its definition. */
    select(index: number): { vehicle: Vehicle; def: VehicleDef } {
        if (index !== this._index && index >= 0 && index < this._vehicles.length) {
            this._park(this._vehicles[this._index]!);
            this._index = index;
        }
        return { vehicle: this.current, def: VEHICLES[this._index]! };
    }

    /**
     * Stow an inactive vehicle far off-screen. (Lite's per-mesh `visible` flag isn't honored for
     * these loaded glTF meshes, so we move the model instead; the active car is re-placed each
     * frame by the controller.)
     */
    private _park(vehicle: Vehicle): void {
        vehicle.root.position.set(0, -1000, 0);
    }
}
