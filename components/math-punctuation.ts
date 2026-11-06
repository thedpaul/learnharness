/**
 * Keeps punctuation with the inline math it belongs to. KaTeX output is an
 * inline-block, so the browser may break the line between "$h = 8192$" and
 * the "." after it, leaving the period alone on the next line. This runs
 * after the math plugin's rehype step and wraps each inline formula with
 * the punctuation touching it (a closing ".,;:!?)]" after it, an opening
 * "([" before it) in one no-wrap span (.lh-math-glue, globals.css).
 */
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { Pluggable } from "unified";

const AFTER = /^[.,;:!?)\]}%…]+/;
const BEFORE = /[(\[{]+$/;

const classes = (node: ElementContent | RootContent): string[] => {
	if (node.type !== "element") return [];
	const c: unknown = node.properties?.className;
	return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(/\s+/) : [];
};

const isInlineMath = (node: ElementContent | RootContent) => {
	const c = classes(node);
	return c.includes("katex") && !c.includes("katex-display");
};

function glue(parent: Root | Element): void {
	const kids = parent.children as ElementContent[];
	for (let i = 0; i < kids.length; i++) {
		const node = kids[i]!;
		if (!isInlineMath(node)) {
			if (node.type === "element") glue(node);
			continue;
		}
		const next = kids[i + 1];
		const prev = kids[i - 1];
		const after = next?.type === "text" ? AFTER.exec(next.value)?.[0] : undefined;
		const before = prev?.type === "text" ? BEFORE.exec(prev.value)?.[0] : undefined;
		if (!after && !before) continue;
		const inner: ElementContent[] = [];
		if (before) {
			(prev as Text).value = (prev as Text).value.slice(0, -before.length);
			inner.push({ type: "text", value: before });
		}
		inner.push(node);
		if (after) {
			(next as Text).value = (next as Text).value.slice(after.length);
			inner.push({ type: "text", value: after });
		}
		kids[i] = { type: "element", tagName: "span", properties: { className: ["lh-math-glue"] }, children: inner };
	}
}

/** Wrap a rehype plugin (the math plugin's KaTeX step) so the glue runs right after it. */
export function withMathGlue(plugin: Pluggable): Pluggable {
	const [fn, ...options] = Array.isArray(plugin) ? plugin : [plugin];
	function composed(this: unknown) {
		const inner = typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).apply(this, options) : undefined;
		// Two parameters: a third (next) would make unified treat the step as async.
		return (tree: Root, file: unknown) => {
			const out = typeof inner === "function" ? (inner as (...a: unknown[]) => unknown)(tree, file) : undefined;
			const finish = (t?: unknown) => {
				glue((t as Root | undefined) ?? tree);
				return (t as Root | undefined) ?? tree;
			};
			return out instanceof Promise ? out.then(finish) : finish(out as Root | undefined);
		};
	}
	return composed as Pluggable;
}
