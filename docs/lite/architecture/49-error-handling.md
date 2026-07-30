# Module: Error Handling

> Package paths: `packages/babylon-lite/src/lite-error.ts`, `packages/babylon-lite/src/enable-error-decoding.ts`,
> `packages/babylon-lite/src/error-messages.ts`, `scripts/lite-error-plugin.ts`
> Public exports: `enableErrorDecoding`, `decodeError`

## Purpose

Keep verbose, developer-facing error text **out of every shipped bundle** while still letting you recover
the full message whenever you actually need it.

Long human-readable error strings are surprisingly expensive: every `throw new Error("…detailed message…")`
ships its literal text in your production bundle, even though the overwhelming majority of apps never read
it. Babylon Lite moves that text into a separate, lazily-loaded `code → message` table so the runtime you
ship carries only a compact numeric code — and gives you two explicit ways to get the real message back.

## Default behavior: errors are just codes

At build time a Vite plugin (`scripts/lite-error-plugin.ts`) rewrites every internal
`throw new Error("…")` into `ThrowLiteError(code, …args)`. At runtime, a thrown Babylon Lite error carries:

- **`error.message`** — the bare code, formatted as `#<code>` (e.g. `#12`).
- **`error.lite`** — an array of the runtime values the original message would have
  interpolated (the offending mesh name, an invalid size, etc.).

The verbose message text lives in a table that is **not loaded by default**. A scene that never decodes an
error pays nothing for the message strings — that is the whole point, and it is where the bundle savings
come from.

```text
// What you see by default when a Lite error is thrown:
Error: #12
```

That is intentional. If you never opt in, you never pay for the text. When you *do* need the message, pick
one of the two APIs below.

## Option 1 — `enableErrorDecoding()`: full messages, always

Import it and call it once (typically in development, or from a global error handler). Importing the
function is what pulls the message-table chunk into your bundle; the call itself only installs the
decoder. From that point on, **every error thrown afterwards** — caught or uncaught — reports its
full human-readable text via `error.message`, exactly like a normal `Error`.

```typescript
import { enableErrorDecoding } from "@babylonjs/lite";

// e.g. during development, or behind a debug flag
enableErrorDecoding();

// Any Lite error thrown after this point self-describes:
//   Error: Mesh "hull" has no position data
```

Because importing this pulls the message-table chunk into your bundle, **prefer to leave it out of
production builds** — including it defeats the size win for every user who never hits an error. Guard it
behind a dev/debug flag or a dynamic import if you want it only in development.

## Option 2 — `decodeError(error)`: decode on the fly

`decodeError` reconstructs the full message from a **single caught error**, and works **even when
`enableErrorDecoding()` was never called**. It reads the code back out of the `#<code>` message and the args
off `error.lite`, then runs them through the message table to produce the final string.

```typescript
import { decodeError } from "@babylonjs/lite";

try {
    // …some Lite call…
} catch (err) {
    const message = decodeError(err); // full human-readable message
    telemetry.report(message);
}
```

If the error was already decoded (decoding was enabled when it was thrown) or isn't a Babylon Lite coded
error, `decodeError` returns its message unchanged, so it is always safe to call.

### The production-telemetry use case

This is what `decodeError` is designed for. In production you deliberately **do not** call
`enableErrorDecoding()` (so the message table stays out of your shipped bundle), but when an unexpected error
does fire you still need its details for logging or telemetry. Load the decoder **only at that moment** with
a dynamic import, so the table cost is paid lazily — and only if an error actually occurs:

```typescript
try {
    // …
} catch (err) {
    const { decodeError } = await import("@babylonjs/lite");
    telemetry.report(decodeError(err)); // full message, reconstructed after the fact
}
```

The message table chunk is only fetched when `decodeError` (or `enableErrorDecoding`) is actually
referenced, so a build that never imports either ships zero message text.

## Choosing between them

| You want…                                                             | Use                     | Bundle cost                                              |
| --------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Full messages on **every** error, all the time (dev / debugging)      | `enableErrorDecoding()` | Message table pulled in wherever it is imported          |
| Full message from a **specific caught** error, no global setup        | `decodeError(error)`    | Message table pulled in wherever it is imported          |
| Smallest possible production bundle, decode lazily only when it fires  | `decodeError` via `await import(...)` inside `catch` | Table fetched only when an error is actually decoded |
| Nothing — you never read Lite error text                              | *(default)*             | **Zero** — no message text shipped                       |

> The interpolation args are attached to the error object rather than serialized into the message. This keeps
> every scene bundle smaller, preserves full fidelity for decoding, and guarantees error construction can
> never itself throw.
