"use client";

/**
 * In-flight sharing for the side reads of a session (fluidity pass,
 * 2026-11-06): opening a session mounted three surfaces that each read the
 * whole session record for one field — the coverage ring (`coverage`), the
 * model pill (`settings`), the cost line (`turns`, `pricing`) — plus two
 * reads of /api/settings: four downloads and JSON parses of a transcript
 * that can be half a megabyte, on the phone's main thread. Reads of the
 * same URL that overlap now share ONE request and ONE parsed body. Nothing
 * is cached past the response: a read that starts after it settles fetches
 * fresh, so every refetch-on-event keeps its meaning.
 *
 * The body is shared by reference — callers only read it.
 */

export interface SharedRead<T> {
	ok: boolean;
	status: number;
	/** Parsed JSON; null when the response wasn't ok or wasn't JSON. */
	body: T | null;
}

const inflight = new Map<string, Promise<SharedRead<unknown>>>();

export function sharedGetJson<T>(url: string): Promise<SharedRead<T>> {
	let read = inflight.get(url);
	if (!read) {
		read = (async () => {
			const res = await fetch(url);
			const body = res.ok ? await res.json().catch(() => null) : null;
			return { ok: res.ok, status: res.status, body };
		})().finally(() => inflight.delete(url));
		inflight.set(url, read);
	}
	return read as Promise<SharedRead<T>>;
}
