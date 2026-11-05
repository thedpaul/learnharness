package com.learnharness.android;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * A loopback HTTP proxy for the bundled Claude Code CLI. The CLI is a Linux
 * musl build, and musl resolves hostnames from /etc/resolv.conf, which
 * Android does not have, so every lookup fails (EAI_AGAIN). With
 * HTTPS_PROXY pointing here, the CLI only ever connects to 127.0.0.1 and
 * this side resolves the host with Android's own resolver.
 *
 * Handles CONNECT (HTTPS) and absolute-URI plain HTTP. Bound to loopback and
 * guarded by Proxy-Authorization, so other apps on the phone can't use it.
 */
final class LocalProxy {
	private final ServerSocket server;
	private final String expectedAuth;

	LocalProxy(String user, String password) throws IOException {
		server = new ServerSocket();
		server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
		expectedAuth = "basic " + android.util.Base64.encodeToString(
			(user + ":" + password).getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
		Thread t = new Thread(this::acceptLoop, "lh-proxy");
		t.setDaemon(true);
		t.start();
	}

	int port() { return server.getLocalPort(); }

	private void acceptLoop() {
		while (!server.isClosed()) {
			try {
				Socket client = server.accept();
				Thread t = new Thread(() -> handle(client), "lh-proxy-conn");
				t.setDaemon(true);
				t.start();
			} catch (IOException e) {
				if (server.isClosed()) return;
			}
		}
	}

	/** Reads the request head (through the blank line) as ISO-8859-1 text. */
	private static String readHead(InputStream in) throws IOException {
		ByteArrayOutputStream buf = new ByteArrayOutputStream();
		int state = 0;
		while (state < 4) {
			int b = in.read();
			if (b < 0) throw new IOException("closed");
			buf.write(b);
			if (buf.size() > 65536) throw new IOException("head too large");
			state = (b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3)) ? state + 1 : (b == '\r' ? 1 : 0);
		}
		return buf.toString("ISO-8859-1");
	}

	private void handle(Socket client) {
		Socket upstream = null;
		try {
			client.setSoTimeout(0);
			InputStream cin = client.getInputStream();
			OutputStream cout = client.getOutputStream();
			String head = readHead(cin);
			String[] lines = head.split("\r\n");
			String[] req = lines[0].split(" ");
			if (req.length < 3) { reply(cout, "400 Bad Request"); return; }
			boolean authed = false;
			StringBuilder forwarded = new StringBuilder();
			for (int i = 1; i < lines.length; i++) {
				String line = lines[i];
				if (line.isEmpty()) continue;
				int colon = line.indexOf(':');
				String name = colon > 0 ? line.substring(0, colon).trim().toLowerCase(Locale.ROOT) : "";
				if (name.equals("proxy-authorization")) {
					authed = line.substring(colon + 1).trim().equalsIgnoreCase(expectedAuth);
					continue;
				}
				if (name.equals("proxy-connection")) continue;
				forwarded.append(line).append("\r\n");
			}
			if (!authed) {
				cout.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"lh\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
				cout.flush();
				return;
			}
			String method = req[0];
			if (method.equalsIgnoreCase("CONNECT")) {
				String target = req[1];
				int c = target.lastIndexOf(':');
				String host = c > 0 ? target.substring(0, c) : target;
				int port = c > 0 ? Integer.parseInt(target.substring(c + 1)) : 443;
				if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
				upstream = new Socket(host, port);
				cout.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
				cout.flush();
			} else {
				java.net.URI uri = java.net.URI.create(req[1]);
				if (uri.getHost() == null || !"http".equalsIgnoreCase(uri.getScheme())) { reply(cout, "400 Bad Request"); return; }
				upstream = new Socket(uri.getHost(), uri.getPort() > 0 ? uri.getPort() : 80);
				String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
				if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();
				String outHead = method + " " + path + " " + req[2] + "\r\n" + forwarded + "\r\n";
				upstream.getOutputStream().write(outHead.getBytes(StandardCharsets.ISO_8859_1));
			}
			Socket up = upstream;
			OutputStream uout = up.getOutputStream();
			Thread t = new Thread(() -> pipe(cin, uout, client, up), "lh-proxy-up");
			t.setDaemon(true);
			t.start();
			pipe(up.getInputStream(), cout, client, up);
		} catch (Exception e) {
			closeQuietly(client);
			closeQuietly(upstream);
		}
	}

	private static void reply(OutputStream out, String status) throws IOException {
		out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
		out.flush();
	}

	private static void pipe(InputStream in, OutputStream out, Socket a, Socket b) {
		byte[] buf = new byte[16384];
		try {
			int n;
			while ((n = in.read(buf)) >= 0) { out.write(buf, 0, n); out.flush(); }
		} catch (IOException ignored) {
		} finally {
			closeQuietly(a);
			closeQuietly(b);
		}
	}

	private static void closeQuietly(Closeable c) {
		if (c == null) return;
		try { c.close(); } catch (IOException ignored) {}
	}
}
