/** After a sync changes local files, the matching change events go out so
 *  open views refetch (notify → fetch, src/core/events.ts). */
import { emit } from "../../core/events.ts";
import type { SyncResult } from "./engine.ts";

export function announce(result: SyncResult): void {
	const changed = result.changedLocal;
	if (changed.length === 0) return;
	if (changed.some((p) => p.startsWith("chats/"))) emit("chats-changed", {});
	for (const p of changed) {
		const m = /^chats\/(.+)\.json$/.exec(p);
		if (m) emit("record-changed", { chatId: m[1]! });
	}
	if (changed.some((p) => p.startsWith("jobs/"))) emit("jobs-changed", {});
	if (changed.some((p) => p.startsWith("chats/") || p.startsWith("review"))) emit("reviews-changed", {});
	if (changed.some((p) => p.startsWith("graph/"))) {
		emit("sources-changed", {});
		emit("activity-changed", {});
	}
}
