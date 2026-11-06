"use client";

/**
 * Phones: the dictation mic sits at the end of the dock's control row
 * under the thumb — right by default, left for left-handed use (Settings →
 * Appearance → Mic side; stored on this device). The CSS keys off
 * html.lh-hand-left (android/overlay/apply.mjs).
 */
import { useEffect } from "react";

export type Hand = "left" | "right";
const KEY = "lh:handedness";

export function handedness(): Hand {
	try {
		return localStorage.getItem(KEY) === "left" ? "left" : "right";
	} catch {
		return "right";
	}
}

export function setHandedness(hand: Hand): void {
	try {
		localStorage.setItem(KEY, hand);
	} catch { /* private mode: this session only */ }
	document.documentElement.classList.toggle("lh-hand-left", hand === "left");
}

export function AndroidHandedness() {
	useEffect(() => {
		document.documentElement.classList.toggle("lh-hand-left", handedness() === "left");
	}, []);
	return null;
}
