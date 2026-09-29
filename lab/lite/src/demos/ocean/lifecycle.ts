import { disposeEngine, stopEngine, waitForGpuResourceRetirements, type EngineContext } from "babylon-lite";
import type { OceanSimulation } from "./simulation.js";

export async function disposeOceanDemoResources(engine: EngineContext, simulation: OceanSimulation | undefined): Promise<void> {
    stopEngine(engine);
    try {
        try {
            await waitForGpuResourceRetirements(engine);
        } finally {
            simulation?.dispose();
        }
    } finally {
        disposeEngine(engine);
    }
}
