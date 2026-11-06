import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";

const render = (md: string) => renderToStaticMarkup(React.createElement(MessageResponse, { mode: "static" }, md));

test("math glue: punctuation after (and an opening bracket before) inline math stays with it", () => {
	const html = render("Model C: one dense FFN with $h = 8192$. Then ($x$), done.");
	assert.equal((html.match(/class="lh-math-glue"/g) ?? []).length, 2);
	assert.match(html, /lh-math-glue">[\s\S]*8192[\s\S]*<\/span>\.<\/span>/, "the period is inside the glue span");
	assert.match(html, /lh-math-glue">\([\s\S]*<\/span>\),<\/span>/, "( before and ), after");
	assert.match(html, /<\/span> Then /, "the text after the period is untouched");
});

test("math glue: math with spaces around it, and display math, are left alone", () => {
	assert.doesNotMatch(render("so $a$ and $b$ are"), /lh-math-glue/);
	assert.doesNotMatch(render("$$\nx = 1\n$$\n\n."), /lh-math-glue/);
});

test("math glue: the formula inside still wraps (only the punctuation joint is held)", async () => {
	const html = render("so $-(z_y-\\log\\sum_j e^{z_j})=-z_y+\\log\\sum_j e^{z_j}$.");
	assert.match(html, /class="lh-math-glue"><span class="katex">/, "the formula is a direct child of the glue");
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-math-glue > \.katex \{\s*white-space: normal;/, "nowrap does not reach into the formula");
});
