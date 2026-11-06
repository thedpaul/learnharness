import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteMarkdown } from "../components/note-markdown.tsx";

test("check notes render their LaTeX instead of showing it raw", () => {
	const html = renderToStaticMarkup(React.createElement(NoteMarkdown, null, "Variance is $d_k$, so divide by $\\sqrt{d_k}$."));
	assert.match(html, /class="katex"/);
	assert.doesNotMatch(html, /\$d_k\$/, "no raw dollar math left");
	assert.match(html, /lh-note-md/);
});

test("check notes keep the note's own type (the prose font reset)", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-prose\.lh-note-md \{\s*font-family: inherit;\s*font-size: inherit;\s*line-height: inherit;/);
	assert.match(css, /\.lh-note-md :where\(p\) \{\s*margin: 0;/);
});
