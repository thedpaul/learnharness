/**
 * Cloud sync merges (Google Drive sync): pure three-way merges against the
 * BASE — the copy both devices agreed on at the last sync. No IO.
 *
 * Ledgers (graph/*.jsonl) are append-only logs that readers merge by id,
 * so two devices' progress combines line by line: a line added on either
 * side is kept, a line removed on either side (session deletion rewrites
 * the ledgers) stays removed. Local order is kept and remote additions are
 * appended, so "the first line for an id defines it" still holds.
 *
 * settings.json merges per top-level key; device-specific keys always keep
 * the local value (SYNC_DEVICE_SETTINGS).
 */

/** Settings that describe THIS device, never synced. */
export const SYNC_DEVICE_SETTINGS = ["dictation", "claudeCode", "customProvider"] as const;

function lines(text: string): string[] {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export function mergeLedgerText(base: string, local: string, remote: string): string {
	const baseSet = new Set(lines(base));
	const localLines = lines(local);
	const remoteLines = lines(remote);
	const localSet = new Set(localLines);
	const remoteSet = new Set(remoteLines);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of localLines) {
		if (baseSet.has(line) && !remoteSet.has(line)) continue; // removed remotely
		if (seen.has(line)) continue;
		seen.add(line);
		out.push(line);
	}
	for (const line of remoteLines) {
		if (seen.has(line) || localSet.has(line)) continue;
		if (baseSet.has(line)) continue; // removed locally
		seen.add(line);
		out.push(line);
	}
	return out.length > 0 ? `${out.join("\n")}\n` : "";
}

function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(v) ?? "undefined";
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Settings as another device sees them: device keys and file-access
 *  folders removed. Two files with equal shared views need no upload. */
export function sharedSettingsJson(settings: unknown): string {
	const out = { ...asObj(settings) };
	for (const key of SYNC_DEVICE_SETTINGS) delete out[key];
	if (out.agent && typeof out.agent === "object") {
		const agent = { ...(out.agent as Obj) };
		delete agent.fileAccess;
		out.agent = agent;
	}
	return stableJson(out);
}

/**
 * Per-key three-way merge. `remoteNewer` breaks ties when both sides
 * changed the same key. Device keys (and agent.fileAccess, whose folders
 * are paths on this device) keep the local value.
 */
export function mergeSettings(base: unknown, local: unknown, remote: unknown, remoteNewer: boolean): Obj {
	const b = asObj(base);
	const l = asObj(local);
	const r = asObj(remote);
	const out: Obj = {};
	const device = new Set<string>(SYNC_DEVICE_SETTINGS);
	for (const key of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
		let value: unknown;
		if (device.has(key)) value = l[key];
		else if (same(l[key], b[key])) value = r[key];
		else if (same(r[key], b[key])) value = l[key];
		else value = remoteNewer ? r[key] : l[key];
		if (value !== undefined) out[key] = value;
	}
	const localAccess = asObj(l.agent).fileAccess;
	if (out.agent && typeof out.agent === "object") {
		const agent = { ...(out.agent as Obj) };
		if (localAccess === undefined) delete agent.fileAccess;
		else agent.fileAccess = localAccess;
		out.agent = agent;
	}
	return out;
}
