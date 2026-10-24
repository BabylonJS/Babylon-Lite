import type { NavcatManager, NavcatConnection, NavcatConnectionOptions } from "./navcat-types.js";
import { navcatVersion, navcatFlags, copyNavcatVector } from "./navcat-state.js";

/** Add a connection. Loads mutation code independently of the query runtime. */
export async function addNavcatConnection(manager: NavcatManager, options: NavcatConnectionOptions): Promise<NavcatConnection> {
    const version = navcatVersion(manager);
    const copy: NavcatConnectionOptions = {
        start: copyNavcatVector(options.start, "connection start"),
        end: copyNavcatVector(options.end, "connection end"),
        radius: options.radius,
        bidirectional: options.bidirectional ?? true,
        flags: navcatFlags(options.flags ?? 1),
        area: options.area ?? 0,
    };
    if (!Number.isFinite(copy.radius) || copy.radius <= 0 || !Number.isInteger(copy.area) || copy.area! < 0) {
        throw new Error("Navcat connection requires a positive radius and nonnegative integer area");
    }
    return (await import("./navcat-connections-runtime.js")).add(manager, version, copy);
}

/** Remove a current owned connection; stale/foreign/already removed handles return false. */
export async function removeNavcatConnection(manager: NavcatManager, connection: NavcatConnection): Promise<boolean> {
    const version = navcatVersion(manager);
    return (await import("./navcat-connections-runtime.js")).remove(manager, version, connection);
}

/** Whether a current owned connection has attached to both surface polygons. */
export async function isNavcatConnectionConnected(manager: NavcatManager, connection: NavcatConnection): Promise<boolean> {
    const version = navcatVersion(manager);
    return (await import("./navcat-connections-runtime.js")).connected(manager, version, connection);
}
