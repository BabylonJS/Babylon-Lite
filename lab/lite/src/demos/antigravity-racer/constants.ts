/**
 * Antigravity Racer — shared tunables.
 *
 * Kept in one place so the track shape, ship handling, and camera feel can be
 * tuned without hunting through every module.
 */

/** Number of sampled rings around the closed spline loop (was `texHeight` in the source PG). */
export const RING_COUNT = 256;

/** The 7 default track control points (world space), exactly as specified for this port. */
export const DEFAULT_CONTROL_POINTS: readonly { x: number; y: number; z: number }[] = [
    { x: 40, y: 14, z: 0 },
    { x: 80, y: 17.28, z: 40 },
    { x: 10, y: 24.92, z: 70 },
    { x: 30, y: 49, z: 90 },
    { x: 60, y: 32, z: 100 },
    { x: 80, y: 14, z: 80 },
    { x: 0, y: 16.2, z: 20 },
];

/** Track cross-section profile (local x = across width, y = up), an open banked channel:
 *  outer rim → inner floor edge → inner floor edge → outer rim. */
export const TRACK_PROFILE: readonly { x: number; y: number }[] = [
    { x: -4.5, y: 1 },
    { x: -3, y: 0 },
    { x: 3, y: 0 },
    { x: 4.5, y: 1 },
];

/** Half-width of the flat floor (inner edge) — ships are gently pushed back inside this. */
export const FLOOR_HALF_WIDTH = 3;

/** Ships travel at up to this many world units per second. */
export const MAX_SPEED = 42; // == original 0.7/frame * 60fps
/** Acceleration, world units per second^2, scaled down as speed approaches MAX_SPEED. */
export const MAX_ACCEL = 14.4; // == original 0.004/frame * 60fps

/** Per-second multiplicative velocity drag (== original 0.99 per frame at 60fps). */
export const VELOCITY_DRAG_PER_SEC = Math.pow(0.99, 60);

/** Boost pad ring spacing/offsets (ring index modulo this period). */
export const BOOST_PERIOD = 32;
export const BOOST_RIGHT_OFFSET = 2;
export const BOOST_LEFT_OFFSET = 6;
/** Speed instantly added when a boost pad is touched (units/second, matches MAX_SPEED scale). */
export const BOOST_SPEED_KICK = 18;
/** Minimum ring separation before another boost from the same ship can trigger again. */
export const BOOST_DEBOUNCE_RINGS = 10;

/** Fixed simulation step, seconds — the whole sim ticks in these increments regardless of display refresh rate. */
export const FIXED_DT = 1 / 60;
/** Safety cap on fixed steps run per rendered frame (avoids a spiral of death after a stall/tab-switch). */
export const MAX_STEPS_PER_FRAME = 6;

/** Ship steering / handling tuning (time constants in seconds, for frame-rate-independent damping). */
export const STEER_RESPONSE_TAU = 0.12;
export const YAW_SPEED_TAU = 0.18;
export const TILT_TAU = 0.16;
export const INERTIA_TAU_AT_FULL_SPEED = 0.85;
export const UP_SMOOTH_TAU = 0.14;

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
/** Ring-index gap between each spawn slot around the loop, so ships start well clear of
 *  each other and of a following chase camera (which pulls back ~9-14 world units). */
export const SPAWN_RING_SPACING = 18;
