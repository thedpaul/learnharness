import { ReviewSession } from "@/components/review-session";

export const dynamic = "force-dynamic";

/** Spaced reviews: your past quiz questions on a schedule (src/core/review.ts). */
export default function ReviewPage() {
	return <ReviewSession />;
}
