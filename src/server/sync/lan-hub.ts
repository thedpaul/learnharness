/**
 * The desktop's phone-sync listener: one sealed endpoint, POST /rpc, on the
 * local network (lan-crypto.ts). A phone sync is
 *   begin  → the desktop syncs its data INTO the hub folder (fresh copy),
 *   list / download / upload / remove → the phone's engine against the hub,
 *   end    → the desktop syncs the hub back into its data (the phone's
 *            changes land, change events go out).
 * One phone at a time: begin holds the hub until end, or until it has been
 * idle for LOCK_IDLE_MS (a phone that dropped off mid-sync).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { folderRemote } from "./folder-remote.ts";
import { isSyncedPath, type Remote, type RemoteFile } from "./engine.ts";
import { ivOf, lanKey, LAN_WINDOW_MS, requestAad, responseAad, seal, unseal } from "./lan-crypto.ts";

const MAX_BODY = 96 * 1024 * 1024;
const LOCK_IDLE_MS = 2 * 60_000;

export type HubOptions = {
	secret: Buffer;
	/** The hub folder the phone reads and writes (data/.sync/lan-hub/files). */
	filesDir: string;
	hubId: string;
	name: string;
	/** The desktop's own sync with the hub folder (begin and end). */
	syncDesktop: () => Promise<void>;
	/** After a phone's sync ends. */
	onPeerSynced?: (device: string) => void;
	now?: () => number;
};

type Rpc = { op: string; path?: string; body?: string; device?: string };

class RpcError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function createHubServer(options: HubOptions): http.Server {
	const key = lanKey(options.secret);
	const now = options.now ?? Date.now;
	const remote: Remote = folderRemote(options.filesDir);
	const seen = new Map<string, number>();
	let lock: { device: string; until: number } | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	const fileArg = (rpc: Rpc): RemoteFile => {
		if (typeof rpc.path !== "string" || !isSyncedPath(rpc.path)) throw new RpcError("bad path");
		return { id: rpc.path, path: rpc.path, md5: "", modifiedTime: "" };
	};
	const holding = (device: string) => {
		if (!lock || lock.device !== device || lock.until < now()) throw new RpcError("no sync in progress; begin first", 409);
		lock.until = now() + LOCK_IDLE_MS;
	};

	const dispatch = async (rpc: Rpc): Promise<unknown> => {
		const device = typeof rpc.device === "string" ? rpc.device.slice(0, 80) : "phone";
		switch (rpc.op) {
			case "hello":
				return { hubId: options.hubId, name: options.name };
			case "begin":
				if (lock && lock.device !== device && lock.until >= now()) throw new RpcError("another device is syncing; try again shortly", 409);
				lock = { device, until: now() + LOCK_IDLE_MS };
				await options.syncDesktop();
				return { hubId: options.hubId };
			case "list":
				holding(device);
				return { files: await remote.list() };
			case "download":
				holding(device);
				return { body: (await remote.download(fileArg(rpc))).toString("base64") };
			case "upload":
				holding(device);
				if (typeof rpc.body !== "string") throw new RpcError("missing body");
				return { file: await remote.upload(fileArg(rpc).path, Buffer.from(rpc.body, "base64")) };
			case "remove":
				holding(device);
				await remote.remove(fileArg(rpc));
				return {};
			case "end":
				holding(device);
				try {
					await options.syncDesktop();
				} finally {
					lock = null;
				}
				options.onPeerSynced?.(device);
				return {};
			default:
				throw new RpcError("unknown op");
		}
	};

	return http.createServer((req, res) => {
		const refuse = (status: number) => {
			res.writeHead(status, { "content-type": "text/plain" }).end(status === 401 ? "unauthorized" : "bad request");
		};
		if (req.method !== "POST" || req.url !== "/rpc") return refuse(404);
		const ts = String(req.headers["x-lh-ts"] ?? "");
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY) req.destroy();
			else chunks.push(c);
		});
		req.on("end", () => {
			const sealed = Buffer.concat(chunks);
			const t = Number(ts);
			const iv = sealed.length >= 12 ? ivOf(sealed) : "";
			let rpc: Rpc;
			try {
				if (!Number.isFinite(t) || Math.abs(now() - t) > LAN_WINDOW_MS) throw new Error("stale");
				if (seen.has(iv)) throw new Error("replay");
				rpc = JSON.parse(unseal(key, sealed, requestAad(ts)).toString("utf-8")) as Rpc;
			} catch {
				return refuse(401);
			}
			const cutoff = now() - 2 * LAN_WINDOW_MS;
			for (const [k, at] of seen) if (at < cutoff) seen.delete(k);
			seen.set(iv, now());
			// One request at a time: the hub folder and the desktop's own
			// syncs never interleave.
			const run = queue.then(() => dispatch(rpc));
			queue = run.catch(() => undefined);
			run.then(
				(value) => ({ status: 200, value }),
				(err: unknown) => ({
					status: err instanceof RpcError ? err.status : 500,
					value: { error: err instanceof Error ? err.message : String(err) },
				}),
			).then(({ status, value }) => {
				const body = seal(key, Buffer.from(JSON.stringify(value)), responseAad(iv));
				res.writeHead(status, { "content-type": "application/octet-stream" }).end(body);
			});
		});
	});
}

/** Listen on all interfaces; resolves with the bound port. */
export function listen(server: http.Server, port: number, host = "0.0.0.0"): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve((server.address() as AddressInfo).port);
		});
	});
}
