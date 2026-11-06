/**
 * Google Drive sync, the service the routes call: status, configuration,
 * and one sync at a time (concurrent callers share the running sync).
 * After a sync changes local files, the matching change events go out so
 * open views refetch (notify → fetch, src/core/events.ts).
 */
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import { runSync, type SyncResult } from "./engine.ts";
import { driveRemote, readCredentials, writeCredentials } from "./google.ts";

export { beginSignIn, finishSignIn, signOut, CALLBACK_PATH } from "./google.ts";

export type SyncStatus = {
	configured: boolean;
	connected: boolean;
	email: string | null;
	auto: boolean;
	running: boolean;
	lastSync: string | null;
	lastError: string | null;
};

const runningKey = "__lhSyncRunning";
function runningSlot(): { current?: Promise<SyncResult> } {
	const g = globalThis as typeof globalThis & { [runningKey]?: { current?: Promise<SyncResult> } };
	return (g[runningKey] ??= {});
}

export function syncStatus(): SyncStatus {
	const c = readCredentials();
	return {
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

function announce(result: SyncResult): void {
	const changed = result.changedLocal;
	if (changed.length === 0) return;
	if (changed.some((p) => p.startsWith("chats/"))) emit("chats-changed", {});
	for (const p of changed) {
		const m = /^chats\/(.+)\.json$/.exec(p);
		if (m) emit("record-changed", { chatId: m[1]! });
	}
	if (changed.some((p) => p.startsWith("jobs/"))) emit("jobs-changed", {});
	if (changed.some((p) => p.startsWith("graph/"))) {
		emit("sources-changed", {});
		emit("activity-changed", {});
	}
}

/** Run one sync now (or join the one already running). */
export function syncNow(): Promise<SyncResult> {
	const slot = runningSlot();
	if (slot.current) return slot.current;
	const run = (async () => {
		try {
			const result = await runSync(PATHS.data, driveRemote);
			writeCredentials({ lastSync: new Date().toISOString(), lastError: undefined });
			announce(result);
			return result;
		} catch (err) {
			writeCredentials({ lastError: err instanceof Error ? err.message : String(err) });
			throw err;
		} finally {
			slot.current = undefined;
		}
	})();
	slot.current = run;
	return run;
}
