/** The fact recheck (src/server/fact-check.ts): GET its status (?scope=1:
 *  how many facts and cards a full recheck checks), POST to recheck now —
 *  { full: true } checks every fact and every review card from scratch. */
import { recheckScope, recheckStatus, runRecheck } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (new URL(request.url).searchParams.get("scope") === "1") return Response.json(recheckScope());
	return Response.json(recheckStatus());
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { full?: unknown } | null;
	void runRecheck({ force: true, full: body?.full === true });
	return Response.json(recheckStatus());
}
