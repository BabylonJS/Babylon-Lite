# Module: Standalone device input

> Package path: `packages/babylon-lite/src/input/`

## Purpose and ownership

Opt-in browser input for gameplay outside camera controllers (issue #410).
Applications own the state and its lifetime; no engine or scene references,
render hooks, device registries, dependencies, or import-time DOM access.
All functions/types are named root exports; each device family is independent.

## Public API

```ts
interface KeyboardInput { readonly keys: ReadonlySet<string> }
createKeyboardInput(target: HTMLElement | Window): KeyboardInput;
isKeyboardKeyDown(input: KeyboardInput, code: string): boolean;
disposeKeyboardInput(input: KeyboardInput): void;

interface PointerInput {
    x: number; y: number;
    deltaX: number; deltaY: number;
    wheelX: number; wheelY: number; wheelZ: number; wheelDeltaMode: number;
    buttons: number; pointerId: number | null; pointerType: string;
}
createPointerInput(element: HTMLElement): PointerInput;
resetPointerInput(input: PointerInput): void;
disposePointerInput(input: PointerInput): void;

interface GamepadButtonState { value: number; pressed: boolean; touched: boolean }
interface GamepadState {
    id: string; index: number; mapping: GamepadMappingType; timestamp: number;
    axes: number[]; buttons: GamepadButtonState[];
}
readGamepad(index?: number): GamepadState | null;
```

Implementations retain an optional `@internal _dispose` callback on keyboard
and pointer state. Public states have no attached behavior methods.

## Keyboard lifecycle

Physical `KeyboardEvent.code` values (e.g. `KeyW`) identify held keys.
Listen for keydown on the supplied target and keyup on its owning window.
Clear on target/descendant/window blur, hidden document, or disposal. Repeats are idempotent.
Resolve document/window from the target, including iframe targets.
Factories require a document with a window; callers make elements focusable.
Disposal removes every listener, clears state, and is idempotent.

## Pointer lifecycle and units

Observe owning-window pointer events in capture phase, without taking capture,
preventing defaults, changing focus/styles, or stopping propagation. Camera
listeners remain responsible for their own gestures and browser defaults.
Accept primary pointers over the element, or the current pressed pointer
outside it. A held pointer entering on movement becomes the tracked contact;
a zero-button move releases it if a prior release was missed. Another primary
device cannot take over an active drag.

Positions are CSS pixels relative to `getBoundingClientRect()`'s top-left,
not drawing-buffer pixels. Deltas accumulate client-coordinate movement;
the first event or a pointer-identity change seeds the baseline. Pointer lock
uses `movementX/Y`. Pointer-lock entry/exit (including another element) clears
held/transient state and seeds a new client baseline. An application converts
positions for picking as needed.
`buttons` follows DOM bitmasks: primary 1, secondary 2, auxiliary 4.

Wheel values retain DOM delta units: mode 0 pixels, 1 lines, 2 pages. Events
in the same mode accumulate; a mode change starts a fresh wheel batch so
incompatible units are never added. Earlier unconsumed batches are discarded;
for example pixel +10 followed by line +1 exposes only line +1. Consumers
normalize units if needed, or observe wheel events directly for lossless mixed modes.
`resetPointerInput` clears motion and wheel deltas/mode after a frame reads them;
it retains position and held buttons. Release outside the element is observed.
Cancellation, lost capture, blur, hidden document, and disposal clear the
pressed identity and transient input. An unrelated pointer cancellation does
not affect the active pointer. Ordinary release retains the last pointer identity,
position, and accumulated motion with buttons zero. Disposal removes all listeners.
For touch gameplay, callers set `touch-action` on their own element.

## Gamepads and browser limits

Each `readGamepad` polls the requested navigator slot (default 0). Invalid
negative/noninteger slots throw RangeError. Missing Gamepad API, denied access,
or absent/disconnected slots return null. Results copy axes and each button,
so later browser updates do not mutate an earlier snapshot. No dead zone,
Nintendo/Xbox guessing, device events, vibration, or XR policy is imposed.
Only `mapping === "standard"` guarantees standard button/axis positions.

## Verification and file manifest

- `input/keyboard-input.ts`, `pointer-input.ts`, `gamepad-input.ts`: families.
- `tests/lite/unit/*-input.test.ts`: identity, cleanup, units and owned snapshots.
- `tests/lite/plumbing/device-input.spec.ts`: real browser input and camera coexistence.
- `tests/lite/build/device-input.test.ts`: root declarations and tree-shaking isolation.
- `lab/lite/device-input.html` and `lab/lite/src/device-input.ts`: DOM-only fixture.
- `playground/examples/device-input.ts`: WASD/pointer/gamepad render-loop example.
- Migration: [Porting guide](../03-porting-guide.md#raw-gameplay-input).
