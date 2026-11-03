import { addOffMeshConnection, removeOffMeshConnection, isOffMeshConnectionConnected } from "navcat";
import type { NavMesh } from "navcat";
import type { NavcatManager, NavcatConnection, NavcatConnectionOptions } from "./navcat-types.js";
import { checkNavcatVersion, toNavcat } from "./navcat-state.js";

function valid(manager: NavcatManager, mesh: NavMesh, connection: NavcatConnection): boolean {
    return (
        connection._owner === manager &&
        connection._meshVersion === manager._meshVersion &&
        !connection._removed &&
        mesh.offMeshConnections[connection.id]?.sequence === connection._sequence
    );
}

export function add(manager: NavcatManager, version: number, options: NavcatConnectionOptions): NavcatConnection {
    const mesh = checkNavcatVersion(manager, version);
    const id = addOffMeshConnection(mesh, {
        start: toNavcat(options.start),
        end: toNavcat(options.end),
        radius: options.radius,
        direction: options.bidirectional ? 1 : 0,
        flags: options.flags!,
        area: options.area!,
    });
    manager._revision++;
    return { id, _owner: manager, _meshVersion: version, _sequence: mesh.offMeshConnections[id]!.sequence, _removed: false };
}

export function remove(manager: NavcatManager, version: number, connection: NavcatConnection): boolean {
    const mesh = checkNavcatVersion(manager, version);
    if (!valid(manager, mesh, connection)) {
        return false;
    }
    removeOffMeshConnection(mesh, connection.id);
    connection._removed = true;
    manager._revision++;
    return true;
}

export function connected(manager: NavcatManager, version: number, connection: NavcatConnection): boolean {
    const mesh = checkNavcatVersion(manager, version);
    return valid(manager, mesh, connection) && isOffMeshConnectionConnected(mesh, connection.id);
}
