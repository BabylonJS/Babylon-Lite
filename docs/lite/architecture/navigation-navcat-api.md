# Navcat API and results

All symbols are named root exports. `Vec3` is Lite's `{ x, y, z }` state type. Optional fields use the defaults in the linked contracts. Handles are produced by the factories, rather than fabricated by consumers.

```ts
interface NavcatManager {
    readonly backend: "navcat";
}
interface NavcatNode {
    readonly nodeRef: number;
    readonly flags: number;
    readonly area: number;
    readonly kind: "polygon" | "connection";
}
interface NavcatFilter {
    includeFlags?: number;
    excludeFlags?: number;
    pass?: (node: Readonly<NavcatNode>) => boolean;
    cost?: (from: Readonly<Vec3>, to: Readonly<Vec3>, current: Readonly<NavcatNode>, previous: Readonly<NavcatNode> | null, next: Readonly<NavcatNode> | null) => number;
}
interface NavcatOptions {
    halfExtents?: Vec3;
    filter?: NavcatFilter;
}
interface NavcatLocation {
    readonly nodeRef: number;
    readonly position: Vec3;
    readonly revision: number;
}
type NavcatNearestResult = { success: false } | { success: true; location: NavcatLocation };
interface NavcatPathPoint {
    position: Vec3;
    nodeRef: number | null;
    offMesh: boolean;
}
interface NavcatPathOptions {
    keepSearch?: boolean;
}
interface NavcatPathResult {
    success: boolean;
    complete: boolean;
    points: NavcatPathPoint[];
    nodeRefs: number[];
    revision: number;
}
interface NavcatRaycastResult {
    hit: boolean;
    fraction: number;
    position: Vec3;
    normal: Vec3;
    nodeRefs: number[];
}
type NavcatMoveResult = { success: false } | { success: true; location: NavcatLocation; visited: number[] };
```

```ts
createNavcatManager(json: string, options?: NavcatOptions): Promise<NavcatManager>;
replaceNavcatMesh(manager: NavcatManager, json: string): void;
exportNavcatMesh(manager: NavcatManager): string;
setNavcatFilter(manager: NavcatManager, filter: NavcatFilter | null): void;
disposeNavcatManager(manager: NavcatManager): void;
findNavcatNearestPoly(manager: NavcatManager, point: Vec3, halfExtents?: Vec3): NavcatNearestResult;
findNavcatPath(manager: NavcatManager, start: Vec3, end: Vec3, halfExtents?: Vec3, options?: NavcatPathOptions): NavcatPathResult;
raycastNavcat(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatRaycastResult;
moveAlongNavcatSurface(manager: NavcatManager, start: NavcatLocation, end: Vec3): NavcatMoveResult;
```

Path `success` includes partial paths; `complete` is true only for SDK COMPLETE_PATH, never inferred from point count. Preserve SDK straight-point off-mesh flags. Failure has empty point/node arrays. The result retains no A* search graph by default. Set the fifth argument to `{ keepSearch: true }` only when a debug overlay needs the private search snapshot; the snapshot never enters the manager.

Surface raycasts ignore destination Y while traversing polygons. A miss uses `fraction=1`, zero normal and the endpoint projected onto the final polygon; a hit uses clamped SDK t, converted outward normal and projected hit position. SDK `Number.MAX_VALUE`/edge -1 is a miss. Locations must identify a valid passing polygon in the manager's current revision; ray/move throw when a later filter excludes their start. Movement returns the SDK's height-projected position and a fresh location.

```ts
interface NavcatConnectionOptions {
    start: Vec3; end: Vec3; radius: number; bidirectional?: boolean;
    flags?: number; area?: number;
}
interface NavcatConnection { readonly id: number }
addNavcatConnection(manager: NavcatManager, options: NavcatConnectionOptions): Promise<NavcatConnection>;
removeNavcatConnection(manager: NavcatManager, connection: NavcatConnection): Promise<boolean>;
isNavcatConnectionConnected(manager: NavcatManager, connection: NavcatConnection): Promise<boolean>;
```

Connection handles privately store owner and SDK sequence. Successful graph changes increment the manager revision, invalidating old locations/search results while existing connection handles remain valid through their sequence and mesh identity. Repeated removal or a foreign/stale connection returns false. Other operations after manager disposal throw. Options default to bidirectional true, flags 1 and area 0. Radius must be positive. Inputs are copied before the first async boundary; completion after disposal/replacement rejects without mutating an obsolete mesh.

Internal state lives on these same interfaces with `@internal` members: manager `_mesh`, `_api`, `_filter`, `_queryFilter`, `_halfExtents`, `_halfExtentsTuple`, `_revision`, `_meshVersion`, `_disposed`; location `_owner`; connection `_owner`, `_meshVersion`, `_sequence`, `_removed`; path `_owner`, `_search`. The d.ts trim removes these and every SDK-only type import. No public/internal companion interfaces or attached methods.

Filter callbacks receive reusable LH vector/node views, valid only for the synchronous callback. Copy any values needed afterwards. Each manager caches its SDK filter and validated half-extents tuple; the unmodified filter delegates directly to the SDK default. Query scratch tuples and SDK nearest/closest results are reused behind the global reentry guard, while returned public vectors and arrays remain owned snapshots.
