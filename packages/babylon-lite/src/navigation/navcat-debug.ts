import type { NavcatManager, NavcatDebugOptions, NavcatDebugGeometry } from "./navcat-types.js";
import { navcatVersion } from "./navcat-state.js";

/** Create owned CPU debug arrays; caller owns rendering and GPU cleanup. */
export async function createNavcatDebugGeometry(manager: NavcatManager, options: NavcatDebugOptions = {}): Promise<NavcatDebugGeometry[]> {
    const version = navcatVersion(manager);
    const copy = { navMesh: options.navMesh ?? true, connections: options.connections ?? true, search: options.search };
    return (await import("./navcat-debug-runtime.js")).debug(manager, version, copy);
}
