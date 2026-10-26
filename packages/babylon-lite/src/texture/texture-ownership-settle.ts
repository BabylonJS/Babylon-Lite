import type { PendingTextureOwnership } from "../engine/device-lost-recovery.js";

/** @internal Settles a rebuilt texture whose queued total and flag mesh-resource leases changed while it
 *  rebuilt. Only leases change them, so this stays unset — and folds out of the bundle — until a lease is
 *  taken, and settlement without retention pays nothing for it. Kept in its own module so neither the
 *  recovery chunk nor retention pulls in anything else to reach it. */
export let _settleLeasedTextureOwnership: ((pending: PendingTextureOwnership) => void) | null = null;

/** @internal Installed by mesh-resource retention on its first lease. */
export function _installLeasedTextureOwnershipSettle(settle: (pending: PendingTextureOwnership) => void): void {
    _settleLeasedTextureOwnership = settle;
}
