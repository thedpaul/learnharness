package com.learnharness.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.system.Os;

import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs the LearnHarness Next.js server (the same build the desktop app
 * ships) as a child process: Termux's Node.js, installed as libnode.so in
 * the native library directory, executing the payload extracted from
 * assets/server.zip. Foreground so a long agent turn survives the app
 * going to the background.
 */
public final class ServerService extends Service {
	private static final String CHANNEL = "server";
	private Process process;
	private Thread worker;

	@Override public IBinder onBind(Intent intent) { return null; }

	@Override public int onStartCommand(Intent intent, int flags, int startId) {
		startInForeground();
		if (worker == null || !worker.isAlive()) {
			if (ServerRuntime.state() != ServerRuntime.State.READY || process == null || !process.isAlive()) {
				worker = new Thread(this::run, "lh-server");
				worker.start();
			}
		}
		return START_NOT_STICKY;
	}

	@Override public void onTaskRemoved(Intent rootIntent) { stopSelf(); }

	@Override public void onDestroy() {
		if (process != null) process.destroy();
		process = null;
		ServerRuntime.set(ServerRuntime.State.IDLE, "stopped");
		super.onDestroy();
	}

	private void startInForeground() {
		NotificationManager nm = getSystemService(NotificationManager.class);
		nm.createNotificationChannel(new NotificationChannel(CHANNEL, "LearnHarness server", NotificationManager.IMPORTANCE_MIN));
		PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
			PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		Notification n = new Notification.Builder(this, CHANNEL)
			.setContentTitle("LearnHarness is running")
			.setContentText("The local learning server is active.")
			.setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
			.setContentIntent(open)
			.setOngoing(true)
			.build();
		startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
	}

	private void run() {
		try {
			ServerRuntime.set(ServerRuntime.State.PREPARING, "Preparing LearnHarness…");
			File server = preparePayload();
			File runtime = prepareRuntime();
			ServerRuntime.set(ServerRuntime.State.STARTING, "Starting the server…");
			start(server, runtime);
			waitUntilReady();
			ServerRuntime.set(ServerRuntime.State.READY, "");
		} catch (Exception e) {
			ServerRuntime.set(ServerRuntime.State.FAILED, e.getMessage() + "\n\n" + logTail());
		}
	}

	/** Extract the server once per app version (payload stamp in assets). */
	private File preparePayload() throws IOException {
		File dir = new File(getFilesDir(), "server");
		String stamp = readAsset("server.version").trim();
		File mark = new File(dir, ".lh-version");
		if (mark.exists() && readFile(mark).trim().equals(stamp)) return dir;

		ServerRuntime.set(ServerRuntime.State.PREPARING, "Unpacking LearnHarness (first launch takes a moment)…");
		deleteTree(dir);
		if (!dir.mkdirs()) throw new IOException("cannot create " + dir);
		String links = null;
		try (ZipInputStream zip = new ZipInputStream(getAssets().open("server.zip"))) {
			byte[] buf = new byte[1 << 16];
			for (ZipEntry e; (e = zip.getNextEntry()) != null; ) {
				if (e.getName().equals("symlinks.json")) {
					links = new String(zip.readAllBytes(), StandardCharsets.UTF_8);
					continue;
				}
				File out = new File(dir, e.getName());
				if (!out.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new IOException("bad entry " + e.getName());
				if (e.isDirectory()) { out.mkdirs(); continue; }
				out.getParentFile().mkdirs();
				try (OutputStream os = new FileOutputStream(out)) {
					for (int n; (n = zip.read(buf)) > 0; ) os.write(buf, 0, n);
				}
			}
		}
		if (links != null) {
			String nativeDir = getApplicationInfo().nativeLibraryDir;
			JSONArray arr;
			try { arr = new JSONArray(links); } catch (Exception e) { throw new IOException("bad symlinks.json", e); }
			for (int i = 0; i < arr.length(); i++) {
				JSONArray pair = arr.optJSONArray(i);
				File link = new File(dir, pair.optString(0));
				String target = pair.optString(1);
				if (target.startsWith("@native/")) target = nativeDir + "/" + target.substring(8);
				link.getParentFile().mkdirs();
				try { Os.symlink(target, link.getPath()); } catch (Exception e) { throw new IOException("symlink " + link, e); }
			}
		}
		try (OutputStream os = new FileOutputStream(mark)) { os.write(stamp.getBytes(StandardCharsets.UTF_8)); }
		return dir;
	}

	private File prepareRuntime() throws IOException {
		File dir = new File(getFilesDir(), "runtime");
		dir.mkdirs();
		for (String name : new String[] { "openssl.cnf", "cert.pem" }) {
			try (InputStream in = getAssets().open("runtime/" + name); OutputStream out = new FileOutputStream(new File(dir, name))) {
				in.transferTo(out);
			}
		}
		new File(getFilesDir(), "data").mkdirs();
		return dir;
	}

	private static LocalProxy proxy;
	private static String proxyUrl;

	private void start(File server, File runtime) throws IOException {
		int port;
		try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = s.getLocalPort(); }
		byte[] raw = new byte[32];
		new SecureRandom().nextBytes(raw);
		StringBuilder hex = new StringBuilder();
		for (byte b : raw) hex.append(String.format("%02x", b));

		String nativeDir = getApplicationInfo().nativeLibraryDir;
		ProcessBuilder pb = new ProcessBuilder(nativeDir + "/libnode.so", "server.js");
		pb.directory(server);
		Map<String, String> env = pb.environment();
		env.put("LD_LIBRARY_PATH", nativeDir);
		env.put("OPENSSL_CONF", new File(runtime, "openssl.cnf").getPath());
		env.put("SSL_CERT_FILE", new File(runtime, "cert.pem").getPath());
		env.put("NODE_EXTRA_CA_CERTS", new File(runtime, "cert.pem").getPath());
		env.put("HOME", getFilesDir().getPath());
		env.put("TMPDIR", getCacheDir().getPath());
		env.put("NODE_ENV", "production");
		env.put("NEXT_TELEMETRY_DISABLED", "1");
		env.put("PORT", String.valueOf(port));
		env.put("HOSTNAME", "127.0.0.1");
		env.put("LH_DATA_DIR", new File(getFilesDir(), "data").getPath());
		env.put("LH_AUTH_FILE", new File(getFilesDir(), "auth.json").getPath());
		env.put("LH_ANDROID_API_SECRET", hex.toString());
		// The bundled Claude Code CLI (Linux musl build) and the musl loader that runs it.
		env.put("LH_CLAUDE_BIN", nativeDir + "/libclaude.so");
		env.put("LH_CLAUDE_LOADER", nativeDir + "/libldmusl.so");
		env.put("DISABLE_AUTOUPDATER", "1");
		// Claude Code can't resolve hostnames itself on Android (musl reads the
		// missing /etc/resolv.conf); route its traffic through LocalProxy.
		if (proxy == null) {
			byte[] pw = new byte[16];
			new SecureRandom().nextBytes(pw);
			StringBuilder pwHex = new StringBuilder();
			for (byte b : pw) pwHex.append(String.format("%02x", b));
			proxy = new LocalProxy("lh", pwHex.toString());
			proxyUrl = "http://lh:" + pwHex + "@127.0.0.1:" + proxy.port();
		}
		env.put("HTTPS_PROXY", proxyUrl);
		env.put("HTTP_PROXY", proxyUrl);
		env.put("NO_PROXY", "127.0.0.1,localhost,::1");
		pb.redirectErrorStream(true);
		pb.redirectOutput(logFile());

		ServerRuntime.port = port;
		ServerRuntime.secret = hex.toString();
		process = pb.start();
		Process p = process;
		new Thread(() -> {
			try {
				int code = p.waitFor();
				if (process == p) {
					ServerRuntime.set(ServerRuntime.State.FAILED, "The server stopped (exit " + code + ").\n\n" + logTail());
				}
			} catch (InterruptedException ignored) {}
		}, "lh-server-exit").start();
	}

	private void waitUntilReady() throws Exception {
		long deadline = System.currentTimeMillis() + 90_000;
		while (System.currentTimeMillis() < deadline) {
			if (process == null || !process.isAlive()) throw new IOException("The server exited during startup.");
			try {
				HttpURLConnection c = (HttpURLConnection) new URL(ServerRuntime.url() + "api/settings").openConnection();
				c.setRequestProperty("x-learnharness-desktop", ServerRuntime.secret);
				c.setConnectTimeout(1000);
				c.setReadTimeout(5000);
				int code = c.getResponseCode();
				c.disconnect();
				if (code == 200) return;
			} catch (IOException ignored) {}
			Thread.sleep(250);
		}
		throw new IOException("The server did not answer in time.");
	}

	private File logFile() { return new File(getFilesDir(), "server.log"); }

	private String logTail() {
		try {
			String s = readFile(logFile());
			return s.length() > 3000 ? s.substring(s.length() - 3000) : s;
		} catch (IOException e) {
			return "";
		}
	}

	private String readAsset(String name) throws IOException {
		try (InputStream in = getAssets().open(name)) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
	}

	private static String readFile(File f) throws IOException {
		try (BufferedReader r = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f), StandardCharsets.UTF_8))) {
			StringBuilder sb = new StringBuilder();
			for (String line; (line = r.readLine()) != null; ) sb.append(line).append('\n');
			return sb.toString();
		}
	}

	private static void deleteTree(File f) {
		if (!f.exists() && !isSymlink(f)) return;
		if (f.isDirectory() && !isSymlink(f)) {
			File[] kids = f.listFiles();
			if (kids != null) for (File k : kids) deleteTree(k);
		}
		f.delete();
	}

	private static boolean isSymlink(File f) {
		try { return java.nio.file.Files.isSymbolicLink(f.toPath()); } catch (Exception e) { return false; }
	}
}
