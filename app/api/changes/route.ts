/** Changes (src/server/changes.ts): GET the list (?chat=<id> = that
 *  session's flagged questions; ?count=1 = the unseen count only), POST
 *  { ids } to mark changes seen. */
import { listChanges, markChangesSeen } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const chat = params.get("chat");
	const list = listChanges(chat ? { chatId: chat.slice(0, 200) } : {});
	if (params.get("count") === "1") return Response.json({ unseen: list.unseen, total: list.items.length });
	return Response.json(list);
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length < 400).slice(0, 500) : [];
	markChangesSeen(ids);
	return Response.json({ ok: true });
}
