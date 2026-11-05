package com.learnharness.android;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Attachments on Android, exposed to the web UI as window.LHAndroidFiles.
 * LearnHarness attaches files by PATH (the agent reads them from disk), but
 * the system picker only hands out content:// URIs. So the picked files (or
 * a picked folder, recursively) are copied into the app's private
 * ~/attachments/<run>/ and those paths go back to the page as an
 * "lh:android-files" event: {type: "picked", paths} | {type: "cancel"} |
 * {type: "error", message}.
 */
final class FileBridge {
	static final int REQUEST_FILES = 51;
	static final int REQUEST_FOLDER = 52;
	private static final long MAX_BYTES = 512L * 1024 * 1024;
	private static final int MAX_FILES = 5000;

	private final Activity activity;
	private final WebView web;
	private final Handler main = new Handler(Looper.getMainLooper());

	FileBridge(Activity activity, WebView web) {
		this.activity = activity;
		this.web = web;
	}

	@JavascriptInterface public void pickFiles() {
		main.post(() -> {
			Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
			i.addCategory(Intent.CATEGORY_OPENABLE);
			i.setType("*/*");
			i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
			start(i, REQUEST_FILES);
		});
	}

	@JavascriptInterface public void pickFolder() {
		main.post(() -> start(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_FOLDER));
	}

	private void start(Intent intent, int code) {
		try { activity.startActivityForResult(intent, code); }
		catch (Exception e) { emit("error", "message", "No file picker is available on this phone"); }
	}

	/** Called from MainActivity.onActivityResult. */
	void onResult(int code, int resultCode, Intent data) {
		if (resultCode != Activity.RESULT_OK || data == null) { emit("cancel", null, null); return; }
		List<Uri> uris = new ArrayList<>();
		if (code == REQUEST_FILES) {
			if (data.getClipData() != null) {
				for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
			} else if (data.getData() != null) uris.add(data.getData());
		} else if (data.getData() != null) uris.add(data.getData());
		if (uris.isEmpty()) { emit("cancel", null, null); return; }
		new Thread(() -> copy(code, uris), "lh-attach").start();
	}

	private void copy(int code, List<Uri> uris) {
		File run = null;
		try {
			run = newRunDir();
			JSONArray paths = new JSONArray();
			Budget budget = new Budget();
			if (code == REQUEST_FILES) {
				for (Uri uri : uris) {
					File out = unique(run, safeName(displayName(uri), "file"));
					copyFile(uri, out, budget);
					paths.put(out.getPath());
				}
			} else {
				Uri tree = uris.get(0);
				String rootId = DocumentsContract.getTreeDocumentId(tree);
				Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
				File dir = new File(run, safeName(displayName(root), "folder"));
				if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("Could not create " + dir);
				copyTree(tree, rootId, dir, budget, 0);
				paths.put(dir.getPath());
			}
			JSONObject o = new JSONObject().put("type", "picked").put("paths", paths);
			dispatch(o);
		} catch (Exception e) {
			deleteRecursive(run);
			emit("error", "message", e.getMessage() == null ? "Could not copy the files" : e.getMessage());
		}
	}

	private static void deleteRecursive(File f) {
		if (f == null) return;
		File[] kids = f.listFiles();
		if (kids != null) for (File k : kids) deleteRecursive(k);
		f.delete();
	}

	private static final class Budget { long bytes; int files; }

	private File newRunDir() throws IOException {
		byte[] r = new byte[3];
		new SecureRandom().nextBytes(r);
		String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date());
		File dir = new File(new File(activity.getFilesDir(), "attachments"), String.format(Locale.ROOT, "%s-%02x%02x%02x", stamp, r[0], r[1], r[2]));
		if (!dir.mkdirs()) throw new IOException("Could not create the attachments folder");
		return dir;
	}

	private void copyTree(Uri tree, String docId, File dir, Budget budget, int depth) throws IOException {
		if (depth > 32) return;
		Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
		String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
		try (Cursor c = activity.getContentResolver().query(children, cols, null, null, null)) {
			if (c == null) return;
			while (c.moveToNext()) {
				String id = c.getString(0);
				String name = safeName(c.getString(1), "item");
				if (DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) {
					File sub = new File(dir, name);
					if (sub.mkdirs() || sub.isDirectory()) copyTree(tree, id, sub, budget, depth + 1);
				} else {
					copyFile(DocumentsContract.buildDocumentUriUsingTree(tree, id), unique(dir, name), budget);
				}
			}
		}
	}

	private void copyFile(Uri uri, File out, Budget budget) throws IOException {
		if (++budget.files > MAX_FILES) throw new IOException("Too many files (over " + MAX_FILES + ")");
		ContentResolver cr = activity.getContentResolver();
		try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
			if (in == null) throw new IOException("Could not open " + out.getName());
			byte[] buf = new byte[65536];
			int n;
			while ((n = in.read(buf)) >= 0) {
				budget.bytes += n;
				if (budget.bytes > MAX_BYTES) throw new IOException("The selection is too large (over 512 MB)");
				os.write(buf, 0, n);
			}
		}
	}

	private String displayName(Uri uri) {
		try (Cursor c = activity.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
			if (c != null && c.moveToFirst()) return c.getString(0);
		} catch (Exception ignored) {}
		String last = uri.getLastPathSegment();
		return last == null ? null : last.substring(last.lastIndexOf('/') + 1);
	}

	private static String safeName(String name, String fallback) {
		if (name == null) return fallback;
		String s = name.replace('/', '_').replace('\0', '_').trim();
		if (s.isEmpty() || s.equals(".") || s.equals("..")) return fallback;
		return s.length() > 200 ? s.substring(0, 200) : s;
	}

	private static File unique(File dir, String name) {
		File f = new File(dir, name);
		if (!f.exists()) return f;
		int dot = name.lastIndexOf('.');
		String base = dot > 0 ? name.substring(0, dot) : name;
		String ext = dot > 0 ? name.substring(dot) : "";
		for (int i = 2; ; i++) {
			f = new File(dir, base + " (" + i + ")" + ext);
			if (!f.exists()) return f;
		}
	}

	private void emit(String type, String key, String value) {
		try {
			JSONObject o = new JSONObject().put("type", type);
			if (key != null) o.put(key, value);
			dispatch(o);
		} catch (Exception ignored) {}
	}

	private void dispatch(JSONObject o) {
		String js = "window.dispatchEvent(new CustomEvent('lh:android-files',{detail:" + o + "}))";
		main.post(() -> web.evaluateJavascript(js, null));
	}
}
