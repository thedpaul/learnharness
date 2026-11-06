import { ChangesView } from "@/components/changes-view";

export const dynamic = "force-dynamic";

/** Changes: what later checks found — flagged questions, corrected facts (src/server/changes.ts). */
export default function ChangesPage() {
	return <ChangesView />;
}
