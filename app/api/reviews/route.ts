/** Spaced reviews (src/server/reviews.ts): GET the due queue + stats
 *  (?topic=<session id> narrows it; ?count=1 is the badges' due count only),
 *  POST one answer ({ card, selected: number[], confidence? }). */
import { recordReview, reviewCounts, reviewStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	if (params.get("count") === "1") return Response.json(reviewCounts());
	const topic = params.get("topic");
	return Response.json(reviewStatus(new Date(), topic ? { topic: topic.slice(0, 200) } : {}));
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { card?: unknown; selected?: unknown; confidence?: unknown } | null;
	const selected = Array.isArray(body?.selected) ? body.selected.filter((n): n is number => Number.isInteger(n)) : null;
	if (typeof body?.card !== "string" || !selected || selected.length === 0) {
		return Response.json({ message: "Pick an answer" }, { status: 400 });
	}
	const confidence = typeof body.confidence === "number" && Number.isFinite(body.confidence) ? body.confidence : undefined;
	const result = recordReview(body.card, selected, confidence);
	if (!result) return Response.json({ message: "That question is gone (its session was deleted, or its check held it back)" }, { status: 404 });
	return Response.json(result);
}
