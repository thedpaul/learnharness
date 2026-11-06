/**
 * A sync Remote on a plain folder: the desktop's phone-sync hub
 * (data/.sync/lan-hub/files). The desktop syncs its data with this folder,
 * the phone syncs with it over lan-hub.ts — the same three-way engine both
 * times, so nothing about merging is new. Ids are the paths.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { isSyncedPath, type Remote, type RemoteFile } from "./engine.ts";

const md5 = (buf: Buffer) => createHash("md5").update(buf).digest("hex");

export function folderRemote(dir: string): Remote {
	const abs = (rel: string) => {
		if (!isSyncedPath(rel)) throw new Error(`not a synced path: ${rel}`);
		return path.join(dir, rel);
	};
	const entry = (rel: string, body: Buffer): RemoteFile => ({
		id: rel,
		path: rel,
		md5: md5(body),
		modifiedTime: fs.statSync(abs(rel)).mtime.toISOString(),
	});
	return {
		async list() {
			const out: RemoteFile[] = [];
			const walk = (sub: string) => {
				let names: fs.Dirent[] = [];
				try { names = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { return; }
				for (const d of names) {
					const rel = sub ? `${sub}/${d.name}` : d.name;
					if (d.isDirectory()) walk(rel);
					else if (d.isFile() && isSyncedPath(rel)) {
						try { out.push(entry(rel, fs.readFileSync(path.join(dir, rel)))); } catch { /* vanished */ }
					}
				}
			};
			walk("");
			return out;
		},
		async download(file) {
			return fs.readFileSync(abs(file.path));
		},
		async upload(rel, body) {
			const file = abs(rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, body.toString("utf-8"));
			return entry(rel, body);
		},
		async remove(file) {
			fs.rmSync(abs(file.path), { force: true });
		},
	};
}
