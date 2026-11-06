"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

/**
 * Markdown + LaTeX for the small check notes (a flagged card's reason, the
 * Changes page, held-back cards, the recheck result). The checkers write
 * $...$ math there; as plain text it showed raw. The note keeps its own
 * type (size, font, color): .lh-note-md resets the prose font the renderer
 * brings (globals.css).
 */
export function NoteMarkdown({ children, className }: { children: string; className?: string }) {
	return <ToolContentResponse className={cn("lh-note-md", className)}>{children}</ToolContentResponse>;
}
