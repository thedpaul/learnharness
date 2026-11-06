/** The fact recheck (src/server/fact-check.ts): GET its status, POST to
 *  recheck every graph fact and review card now. */
import { recheckStatus, runRecheck } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(recheckStatus());
}

export async function POST() {
	void runRecheck({ force: true });
	return Response.json(recheckStatus());
}
