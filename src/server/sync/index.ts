/**
 * Sync, the service the routes call: status, configuration, and one sync
 * at a time (concurrent callers share the running sync). A phone paired
 * with a computer syncs with it (lan.ts); otherwise Google Drive, when
 * that is switched on. After a sync changes local files, the matching
 * change events go out (announce.ts).
 */
import { PATHS } from "../../../config.ts";
import { GOOGLE_SYNC_ENABLED } from "../../core/sync-flag.ts";
import { announce } from "./announce.ts";
import { runSync, type SyncResult } from "./engine.ts";
import { driveRemote, readCredentials, writeCredentials } from "./google.ts";
import { lanPaired, lanStatus, lanSyncOnce, type LanStatus } from "./lan.ts";

export { beginSignIn, finishSignIn, signOut, CALLBACK_PATH } from "./google.ts";
export { pairWith, renewHubSecret, setHub, setLanAuto, unpair, type LanStatus } from "./lan.ts";

export type SyncStatus = {
	configured: boolean;
	connected: boolean;
	email: string | null;
	auto: boolean;
	running: boolean;
	lastSync: string | null;
	lastError: string | null;
	lan: LanStatus;
};

const runningKey = "__lhSyncRunning";
function runningSlot(): { current?: Promise<SyncResult> } {
	const g = globalThis as typeof globalThis & { [runningKey]?: { current?: Promise<SyncResult> } };
	return (g[runningKey] ??= {});
}

export async function syncStatus(): Promise<SyncStatus> {
	const c = readCredentials();
	return {
		lan: await lanStatus(),
		configured: Boolean(c.clientId && c.clientSecret),
		connected: Boolean(c.refreshToken),
		email: c.email ?? null,
		auto: c.auto ?? true,
		running: Boolean(runningSlot().current),
		lastSync: c.lastSync ?? null,
		lastError: c.lastError ?? null,
	};
}

export function configureSync(clientId: string, clientSecret: string): void {
	const id = clientId.trim();
	const secret = clientSecret.trim();
	if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error("That doesn't look like a Google OAuth client ID (…apps.googleusercontent.com)");
	if (secret.length < 8) throw new Error("Paste the client secret too");
	const prev = readCredentials();
	// A different client can't use the old refresh token.
	writeCredentials({ clientId: id, clientSecret: secret, ...(prev.clientId !== id ? { refreshToken: undefined, email: undefined } : {}) });
}

export function setAutoSync(on: boolean): void {
	writeCredentials({ auto: on });
}

/** Run one sync now (or join the one already running). */
export function syncNow(): Promise<SyncResult> {
	const slot = runningSlot();
	if (slot.current) return slot.current;
	const run = (async (): Promise<SyncResult> => {
		await null; // the slot is set before any path can settle
		try {
			// Phone sync records its own status (lan.ts).
			if (lanPaired()) return await lanSyncOnce();
			if (!GOOGLE_SYNC_ENABLED) throw new Error("Pair with a computer first");
			try {
				const result = await runSync(PATHS.data, driveRemote);
				writeCredentials({ lastSync: new Date().toISOString(), lastError: undefined });
				announce(result);
				return result;
			} catch (err) {
				writeCredentials({ lastError: err instanceof Error ? err.message : String(err) });
				throw err;
			}
		} finally {
			slot.current = undefined;
		}
	})();
	slot.current = run;
	return run;
}
