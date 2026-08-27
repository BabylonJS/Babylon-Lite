/**
 * Antigravity Racer — shared tunables + the source playground's exact data.
 *
 * Everything in the first half of this file is copied verbatim from Cédric
 * Guillemet's playground (snippet WVPVWL#0) so the ported track has the same
 * shape, the same 256-segment procedural piece and the same rock placement.
 * The second half holds the port's own handling/camera tuning, expressed in
 * per-second units so the simulation is frame-rate independent.
 */

/** Number of sampled track segments around the closed loop (`texHeight` in the source PG). */
export const RING_COUNT = 256;

/** The 7 default track control points (world space), exactly as in the source PG. */
export const DEFAULT_CONTROL_POINTS: readonly { x: number; y: number; z: number }[] = [
    { x: 40, y: 14, z: 0 },
    { x: 80, y: 17.28, z: 40 },
    { x: 10, y: 24.92, z: 70 },
    { x: 30, y: 49, z: 90 },
    { x: 60, y: 32, z: 100 },
    { x: 80, y: 14, z: 80 },
    { x: 0, y: 16.2, z: 20 },
];

/**
 * The track piece's cross-section: 20 (x, y) pairs, exactly the source PG's
 * `vertexData.positions` (which duplicates this list at z = 0 and z = 1, giving
 * 40 vertices per segment). Duplicated x values are deliberate — they split the
 * smooth floor from the sloped kerb so each gets its own normal.
 */
export const TRACK_CROSS_SECTION: readonly (readonly [x: number, y: number])[] = [
    [-4.5, 1],
    [-4, 1],
    [-4, 1],
    [-3, 0],
    [-3, 0],
    [-2, 0],
    [-2, 0],
    [-1, 0],
    [-1, 0],
    [0, 0],
    [0, 0],
    [1, 0],
    [1, 0],
    [2, 0],
    [2, 0],
    [3, 0],
    [3, 0],
    [4, 1],
    [4, 1],
    [4.5, 1],
];

/**
 * Per-cross-section-vertex normals, exactly the source PG's `vertexData.normals`
 * (the same 20 entries on both rows). The kerb normals are intentionally left
 * unnormalized in the source; the deformation shader normalizes after rotating
 * them into world space, so keeping the raw values preserves the original shading.
 */
export const TRACK_CROSS_NORMALS: readonly (readonly [x: number, y: number, z: number])[] = [
    [0, 1, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [-1, 1, 0],
    [-1, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
];

/** The 7 decorative boulders' exact transforms, as authored in the source PG.
 *  `rotation` is a Babylon.js Euler triple (applied yaw-pitch-roll, i.e. y-x-z). */
export const ROCK_TRANSFORMS: readonly {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number];
    readonly scaling: readonly [number, number, number];
}[] = [
    {
        position: [14.919785499572754, 5.359964370727539, 53.94139862060547],
        rotation: [0.40364858893413946, 0.5240297720885895, 0.8265141643053172],
        scaling: [0.25000021964959346, 0.2500000819627103, 0.633672263647569],
    },
    {
        position: [81.25670623779297, 12.17314338684082, 9.859283447265625],
        rotation: [0.22023910792802331, -2.667656628991434, 0.8452102933370698],
        scaling: [0.38833311200141907, 0.38833316558663644, 0.38833316558663644],
    },
    {
        position: [33.184200286865234, 11.09041976928711, 16.800865173339844],
        rotation: [0.8222207316109078, -8.232003553685891e-8, 0.2027264954429321],
        scaling: [0.6401844775270334, 0.446726756687501, 0.31929949789412765],
    },
    {
        position: [40.41991424560547, 22.57797622680664, 80.63224029541016],
        rotation: [0.8978238723299995, 2.313247421163601, 2.73770117751742],
        scaling: [0.48783022337472076, 0.9916678089105887, 0.38120491689194397],
    },
    {
        position: [83.2624282836914, 15.179014205932617, 52.025169372558594],
        rotation: [0.8297330270691404, 2.5089762005522624, 2.645788090654041],
        scaling: [0.4861708001618949, 0.33102711693791725, 0.7052777983541679],
    },
    {
        position: [90.48663330078125, -12.005577087402344, 94.15862274169922],
        rotation: [0.8297320455830038, 2.5089763717069005, 1.4393814369997195],
        scaling: [0.8199356143226619, 0.3310270435888885, 0.7052783265514647],
    },
    {
        position: [21.6993465423584, 5.421895503997803, -19.40607452392578],
        rotation: [0.27592929777958775, 2.3825071391433514, -0.8602559062582362],
        scaling: [0.26370371179869834, 0.3310270333694029, 0.7066118938070071],
    },
];

/** Yaw applied to the ship model so its nose points along the track (`ShipTransform.rotation.y` in the PG). */
export const SHIP_MODEL_YAW = Math.PI;

/** Ships travel at up to this many world units per second. */
export const MAX_SPEED = 42; // == original 0.7/frame * 60fps
/** Acceleration, world units per second^2, scaled down as speed approaches MAX_SPEED. */
export const MAX_ACCEL = 14.4; // == original 0.004/frame * 60fps

/** Per-second multiplicative velocity drag (== original 0.99 per frame at 60fps). */
export const VELOCITY_DRAG_PER_SEC = Math.pow(0.99, 60);

/** Boost strip segment spacing/offsets — the source PG's `(i & 31) == 2` / `== 6` track-info rows. */
export const BOOST_PERIOD = 32;
export const BOOST_RIGHT_OFFSET = 2;
export const BOOST_LEFT_OFFSET = 6;
/** Speed instantly added when a boost strip is touched (units/second, matches MAX_SPEED scale). */
export const BOOST_SPEED_KICK = 18;
/** Minimum segment separation before another boost from the same ship can trigger again. */
export const BOOST_DEBOUNCE_RINGS = 10;

/** Fixed simulation step, seconds — the whole sim ticks in these increments regardless of display refresh rate. */
export const FIXED_DT = 1 / 60;
/** Safety cap on fixed steps run per rendered frame (avoids a spiral of death after a stall/tab-switch). */
export const MAX_STEPS_PER_FRAME = 6;

/** Ship steering / handling tuning. */
export const MAX_STEER_TILT = 0.8;
export const MAX_YAW_RATE = 0.05 * 60; // radians/sec at full steer (== original 0.05/frame at 60fps)

/** Chase-camera ship-relative offsets (right, up, forward) for the two cyclable camera positions. */
export const CHASE_CAMERA_OFFSETS: readonly { x: number; y: number; z: number }[] = [
    { x: 0, y: 3.2, z: -8 },
    { x: 0, y: 2, z: -4.2 },
];
export const CHASE_CAMERA_LOOK_AHEAD = 3;
export const CAMERA_LERP_TAU = 0.045;

/** Total ships in a race (human + AI combined). */
export const TOTAL_SHIP_COUNT = 8;
/** Segment-index gap between each spawn slot around the loop, so ships start well clear of
 *  each other and of a following chase camera (which pulls back ~9-14 world units). */
export const SPAWN_RING_SPACING = 18;

/** Generous world bounds shared by every mesh whose vertices are placed by a shader or
 *  rewritten every frame (the deformed track, the ribbon trails). Mirrors the source PG's
 *  explicit `setBoundingInfo(-1000 … 1000)` so frustum culling never drops them. */
export const HUGE_BOUND_MIN: [number, number, number] = [-1000, -1000, -1000];
export const HUGE_BOUND_MAX: [number, number, number] = [1000, 1000, 1000];

/** Terrain: same footprint / height range / drop as the source PG's height-mapped ground. */
export const TERRAIN_SIZE = 400;
export const TERRAIN_SUBDIVISIONS = 300;
export const TERRAIN_MAX_HEIGHT = 25;
export const TERRAIN_Y = -2.05;
