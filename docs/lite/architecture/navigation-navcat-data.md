# Navcat data, callbacks and lifecycle

## Ownership and JSON

The factory accepts a string containing raw Navcat 0.4.1 `JSON.stringify(navMesh)` data in RH coordinates. The string is parsed into an exclusively owned object. Export returns a fresh string in the same SDK format, including added connections. This is a developer asset format, not a stable cross-version network protocol.

Validate an object root, finite 3-component origin, positive tile dimensions, nodes/links arrays, tiles/mapping/connection records and index-pool objects before publication. Tile entries need numeric coordinate/detail arrays, polygon and detail-mesh arrays, BV tree data and poly-node arrays. SDK-generated JSON is the authoritative full nested schema; no adapter-specific envelope or lossy rebaking is added. Reject malformed roots with `Invalid Navcat JSON` and preserve the current mesh on parse/validation failure.

Private manager state: nullable SDK mesh and runtime API, copied callback options and half-extents, disposed flag, monotonic graph revision and mesh-version counter. Default extents `{x:1,y:2,z:1}`. All positions are finite; all extents are finite and nonnegative. Flags are 16-bit unsigned integers; areas are nonnegative integers.

## Lifecycle

- Factory validates/copies options before importing the SDK, parses JSON, then publishes one initialized handle.
- Replacement parses and validates completely first. Atomic publication replaces the owned mesh and increments graph revision and mesh version; filter/extents survive. Old meshes/caches/connections are no longer retained by the manager.
- Connection add/remove increments graph revision. Connection handles retain no mesh; mesh version and SDK sequence guard removal after replacement or pool ID reuse.
- Disposal is synchronous/idempotent: set disposed, increment revision/version, clear mesh/API/filter/extents. SDK meshes need no explicit WASM destroy. No hooks, crowds, caches, debug objects, timers or workers exist on the manager.
- Every API except repeat disposal checks liveness. Synchronous calls after disposal throw `Navcat manager is disposed`. Pending async optional operations check mesh version after import, so replacement/disposal cannot resurrect an old mesh.
- Location operations reject wrong owners, outdated graph revisions and invalid/non-polygon node references. Existing snapshots remain caller-owned after disposal, but cannot be reused to query the manager.

## Filters

Copy the filter's option object on assignment, preserving callback identity; do not mutate a shared SDK default filter. Defaults include flags `0xffff`, exclude flags 0, pass all otherwise and Euclidean traversal cost. Include/exclude bits are applied before the optional pass callback.

Each callback receives fresh LH vector/node snapshots, never SDK objects or scratch arrays. Preserve explicit previous/current/next node information, using null for absent adjacent nodes. The cost callback must return a finite nonnegative number or throw a clear adapter error. Navcat's distance heuristic gives optimal paths when costs are at least Euclidean distance; cheaper custom costs inherit the SDK's heuristic behavior.

A module-local primitive reentry flag wraps each query in try/finally. Nested queries, filter replacement, mesh replacement, disposal or direct graph mutation from synchronous query callbacks throw; callbacks must finish before using another manager through the SDK. Throwing callbacks release the flag so the manager can be queried again. This state exists only inside the opt-in navigation modules.

## Coordinate conversion

Convert Lite `(x,y,z)` to SDK `[x,y,-z]`; reverse the same operation for results and normals. Half extents are magnitudes and are never reflected. JSON stays in SDK space. All returned vectors/arrays are fresh owned values. Negative zero may be normalized to zero in output.

## Tests

Exercise JSON roundtrip/replacement failure atomicity; malformed roots; caller option/vector mutation across awaits; ID/ref 0; multiple isolated managers; filtered/no polygon and partial path; forbidden nested queries/mutations and recovery after exceptions; stale/foreign locations and reused connection IDs; pending optional imports vs replacement/disposal; idempotent teardown with cleared internal references and no WebGPU globals.
