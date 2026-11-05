package com.learnharness.android;

import java.util.concurrent.CopyOnWriteArrayList;

/** Process-wide state of the bundled server, shared by the service and UI. */
final class ServerRuntime {
	enum State { IDLE, PREPARING, STARTING, READY, FAILED }

	interface Listener { void onState(State state, String detail); }

	private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
	private static volatile State state = State.IDLE;
	private static volatile String detail = "";
	static volatile int port;
	/** 64 hex chars; the WebView presents it as the lh_android cookie. */
	static volatile String secret;

	static State state() { return state; }
	static String detail() { return detail; }

	static void set(State next, String why) {
		state = next;
		detail = why == null ? "" : why;
		for (Listener l : listeners) l.onState(state, detail);
	}

	static void listen(Listener l) { listeners.add(l); l.onState(state, detail); }
	static void unlisten(Listener l) { listeners.remove(l); }

	static String url() { return "http://127.0.0.1:" + port + "/"; }

	private ServerRuntime() {}
}
