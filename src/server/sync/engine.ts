/**
 * The sync engine (Google Drive sync): a three-way file sync between the
 * data dir and a remote store, against the BASE recorded at the last sync
 * (data/.sync/state.json plus base copies in data/.sync/base/).
 *
 * What syncs is the learning progress and the settings:
 *   chats/*.json, jobs/*.json (settled only: a "running" job would be
 *   re-run by the other device's crash recovery), graph/*, reviews.jsonl
 *   review-checks.jsonl, review-fields.jsonl and seen-changes.jsonl
 *   (spaced-review history, card checks, topic fields, which flagged changes
 *   were seen) and settings.json.
 * Never: models/, debug/, .sync/ itself.
 *
 * Per path, with L/R/B the local/remote/base md5:
 *   L = R            in sync
 *   L = B            only the remote changed  → download (or delete local)
 *   R = B            only the local changed   → upload (or delete remote)
 *   otherwise        both changed → ledgers merge by line, settings by key,
 *                    other files: the newer wins and the other copy is kept
 *                    in data/.sync/conflicts/<time>/.
 * settings.json always merges (never overwrites) so device keys survive.
 * A local file that changes while the sync runs is left for the next run.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeLedgerText, mergeSettings, sharedSettingsJson } from "../../core/sync-merge.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";

export type RemoteFile = { id: string; path: string; md5: string; modifiedTime: string };

/** The remote side (Google Drive's appDataFolder in production). */
export interface Remote {
	list(): Promise<RemoteFile[]>;
	download(file: RemoteFile): Promise<Buffer>;
	/** Create (no id) or replace the file at `path`; returns the new listing entry. */
	upload(path: string, body: Buffer, id?: string): Promise<RemoteFile>;
	remove(file: RemoteFile): Promise<void>;
}

export type SyncResult = {
	uploaded: number;
	downloaded: number;
	merged: number;
	deleted: number;
	conflicts: number;
	/** Local paths this run changed (for change notifications). */
	changedLocal: string[];
};

/** md5 = the agreed base; remote = the Drive copy's md5 when it differs
 *  from the base (settings, whose device keys differ per device). */
type State = { version: 1; files: Record<string, { md5: string; remote?: string }> };

const SYNC_DIR = ".sync";

const md5 = (buf: Buffer) => createHash("md5").update(buf).digest("hex");
const parseJson = (b: Buffer): unknown => { try { return JSON.parse(b.toString("utf-8")) as unknown; } catch { return {}; } };

/** The synced relative paths (POSIX separators). */
export function isSyncedPath(rel: string): boolean {
	if (rel.includes("..") || rel.startsWith("/")) return false;
	if (rel === "settings.json" || rel === "reviews.jsonl" || rel === "review-checks.jsonl" || rel === "review-fields.jsonl" || rel === "seen-changes.jsonl") return true;
	if (/^chats\/[A-Za-z0-9_-]+\.json$/.test(rel)) return true;
	if (/^jobs\/[A-Za-z0-9_-]+\.json$/.test(rel)) return true;
	return /^graph\/[A-Za-z0-9_.-]+\.(jsonl|json)$/.test(rel);
}

const isLedger = (rel: string) => rel.endsWith(".jsonl");

/** Running jobs stay local until they settle. */
function syncable(rel: string, body: Buffer): boolean {
	if (!rel.startsWith("jobs/")) return true;
	try {
		return (JSON.parse(body.toString("utf-8")) as { status?: unknown }).status !== "running";
	} catch {
		return false;
	}
}

function readState(stateDir: string): State {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8")) as State;
		if (raw && raw.version === 1 && raw.files && typeof raw.files === "object") return raw;
	} catch { /* first sync */ }
	return { version: 1, files: {} };
}

function writeState(stateDir: string, state: State): void {
	fs.mkdirSync(stateDir, { recursive: true });
	writeFileAtomicSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

/** The synced local files, plus the paths present but not syncable yet
 *  (running jobs) — those are left alone on both sides this run. */
function localFiles(dataDir: string): { files: Map<string, Buffer>; held: Set<string> } {
	const out = new Map<string, Buffer>();
	const held = new Set<string>();
	const take = (rel: string) => {
		if (!isSyncedPath(rel)) return;
		try {
			const body = fs.readFileSync(path.join(dataDir, rel));
			if (syncable(rel, body)) out.set(rel, body);
			else held.add(rel);
		} catch { /* vanished mid-scan */ }
	};
	take("settings.json");
	take("reviews.jsonl");
	take("review-checks.jsonl");
	take("review-fields.jsonl");
	take("seen-changes.jsonl");
	for (const dir of ["chats", "jobs", "graph"]) {
		let names: string[] = [];
		try { names = fs.readdirSync(path.join(dataDir, dir)); } catch { continue; }
		for (const name of names) take(`${dir}/${name}`);
	}
	return { files: out, held };
}

export type SyncOptions = {
	/** Where the base lives (state.json + base/): one per remote, so a base
	 *  agreed with one remote never reads as deletions against another.
	 *  Default data/.sync (Google Drive). */
	stateDir?: string;
};

export async function runSync(dataDir: string, remote: Remote, now: () => Date = () => new Date(), options: SyncOptions = {}): Promise<SyncResult> {
	const stateDir = options.stateDir ?? path.join(dataDir, SYNC_DIR);
	const state = readState(stateDir);
	const { files: local, held } = localFiles(dataDir);
	const remoteList = await remote.list();
	const result: SyncResult = { uploaded: 0, downloaded: 0, merged: 0, deleted: 0, conflicts: 0, changedLocal: [] };

	// Duplicates (two devices created the same path at once): newest wins;
	// the rest are kept as conflict copies, then removed remotely.
	const remoteByPath = new Map<string, RemoteFile>();
	const extras: RemoteFile[] = [];
	for (const f of remoteList) {
		if (!isSyncedPath(f.path)) continue;
		const prev = remoteByPath.get(f.path);
		if (!prev) { remoteByPath.set(f.path, f); continue; }
		if (f.modifiedTime > prev.modifiedTime) { extras.push(prev); remoteByPath.set(f.path, f); }
		else extras.push(f);
	}

	const stamp = now().toISOString().replace(/[:.]/g, "-");
	const baseFile = (rel: string) => path.join(stateDir, "base", rel);
	const keepConflict = (rel: string, body: Buffer, side: string) => {
		const file = path.join(dataDir, SYNC_DIR, "conflicts", stamp, `${rel}.${side}`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
		result.conflicts++;
	};
	for (const extra of extras) {
		try { keepConflict(extra.path, await remote.download(extra), `remote-${extra.id}`); } catch { /* best effort */ }
		await remote.remove(extra);
	}

	const setBase = (rel: string, body: Buffer, remoteMd5?: string) => {
		const sum = md5(body);
		state.files[rel] = remoteMd5 && remoteMd5 !== sum ? { md5: sum, remote: remoteMd5 } : { md5: sum };
		fs.mkdirSync(path.dirname(baseFile(rel)), { recursive: true });
		fs.writeFileSync(baseFile(rel), body);
	};
	const dropBase = (rel: string) => {
		delete state.files[rel];
		fs.rmSync(baseFile(rel), { force: true });
	};
	const readBase = (rel: string): Buffer => {
		try { return fs.readFileSync(baseFile(rel)); } catch { return Buffer.alloc(0); }
	};
	/** Write only if the local file still is what the scan saw. */
	const writeLocal = (rel: string, expected: Buffer | undefined, body: Buffer): boolean => {
		const file = path.join(dataDir, rel);
		let current: Buffer | undefined;
		try { current = fs.readFileSync(file); } catch { current = undefined; }
		if ((current === undefined) !== (expected === undefined) || (current && expected && !current.equals(expected))) return false;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomicSync(file, body.toString("utf-8"));
		result.changedLocal.push(rel);
		return true;
	};
	const deleteLocal = (rel: string, expected: Buffer): boolean => {
		const file = path.join(dataDir, rel);
		try {
			if (!fs.readFileSync(file).equals(expected)) return false;
		} catch { return true; }
		fs.rmSync(file, { force: true });
		result.changedLocal.push(rel);
		return true;
	};
	const localMtime = (rel: string) => {
		try { return fs.statSync(path.join(dataDir, rel)).mtime.toISOString(); } catch { return ""; }
	};

	const paths = new Set<string>([...local.keys(), ...remoteByPath.keys(), ...Object.keys(state.files)]);
	for (const rel of [...paths].sort()) {
		if (held.has(rel)) continue;
		const lBody = local.get(rel);
		const rFile = remoteByPath.get(rel);
		const L = lBody ? md5(lBody) : null;
		const R = rFile ? rFile.md5 : null;
		const B = state.files[rel]?.md5 ?? null;
		const RB = state.files[rel] ? (state.files[rel]!.remote ?? B) : null;

		if (L === R) {
			if (L === null) dropBase(rel);
			else if (B !== L) setBase(rel, lBody!);
			continue;
		}
		// Settings never overwrite wholesale: device keys must survive.
		const settings = rel === "settings.json" && lBody && rFile;
		if (settings && L === B && R === RB) continue; // nothing new on either side
		if (L === B && !settings) {
			if (!rFile) {
				if (deleteLocal(rel, lBody!)) { dropBase(rel); result.deleted++; }
			} else {
				const body = await remote.download(rFile);
				if (!syncable(rel, body)) continue;
				if (writeLocal(rel, lBody, body)) { setBase(rel, body); result.downloaded++; }
			}
			continue;
		}
		if (R === RB && !settings) {
			if (!lBody) {
				await remote.remove(rFile!);
				dropBase(rel);
				result.deleted++;
			} else {
				await remote.upload(rel, lBody, rFile?.id);
				setBase(rel, lBody);
				result.uploaded++;
			}
			continue;
		}
		// Both changed (or settings with any remote change).
		if (!lBody) {
			const body = await remote.download(rFile!);
			if (writeLocal(rel, undefined, body)) { setBase(rel, body); result.downloaded++; }
			continue;
		}
		if (!rFile) {
			await remote.upload(rel, lBody);
			setBase(rel, lBody);
			result.uploaded++;
			continue;
		}
		const rBody = await remote.download(rFile);
		let merged: Buffer;
		if (isLedger(rel)) {
			merged = Buffer.from(mergeLedgerText(readBase(rel).toString("utf-8"), lBody.toString("utf-8"), rBody.toString("utf-8")));
		} else if (rel === "settings.json") {
			const remoteNewer = rFile.modifiedTime > localMtime(rel);
			merged = Buffer.from(`${JSON.stringify(mergeSettings(parseJson(readBase(rel)), parseJson(lBody), parseJson(rBody), remoteNewer), null, "\t")}\n`);
		} else {
			const remoteNewer = rFile.modifiedTime > localMtime(rel);
			merged = remoteNewer ? rBody : lBody;
			keepConflict(rel, remoteNewer ? lBody : rBody, remoteNewer ? "local" : "remote");
		}
		if (!merged.equals(lBody) && !writeLocal(rel, lBody, merged)) continue;
		let remoteMd5 = rFile.md5;
		const needsUpload = rel === "settings.json"
			? sharedSettingsJson(parseJson(merged)) !== sharedSettingsJson(parseJson(rBody))
			: !merged.equals(rBody);
		if (needsUpload) remoteMd5 = (await remote.upload(rel, merged, rFile.id)).md5;
		setBase(rel, merged, remoteMd5);
		if (needsUpload || !merged.equals(lBody)) result.merged++;
	}
	writeState(stateDir, state);
	return result;
}
