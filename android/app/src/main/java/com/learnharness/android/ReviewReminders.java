package com.learnharness.android;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Review reminders (components/review-reminder.tsx): the web app hands over
 * the schedule (weekdays, "HH:MM") and the latest ready count; an alarm at
 * the next scheduled time posts "Time for your reviews", even when the app
 * is closed. A pause skips every scheduled time until it ends. Inexact (no exact-alarm permission): Android may shift it by a
 * few minutes. Rescheduled after each reminder, on every app start and
 * after a reboot.
 */
public final class ReviewReminders {
	static final String PREFS = "review-reminders";
	static final String CHANNEL = "reviews";
	static final String EXTRA_ROUTE = "lh_route";
	private final Context context;

	ReviewReminders(Context context) { this.context = context.getApplicationContext(); }

	/** {notify, days: [0-6, 0 = Sunday], time: "HH:MM", due, pausedUntil: epoch ms (0 = not paused)} */
	@JavascriptInterface public void configure(String json) {
		try {
			JSONObject o = new JSONObject(json);
			JSONArray days = o.optJSONArray("days");
			StringBuilder d = new StringBuilder();
			for (int i = 0; days != null && i < days.length(); i++) d.append(days.getInt(i));
			context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
				.putBoolean("notify", o.optBoolean("notify"))
				.putString("days", d.toString())
				.putString("time", o.optString("time"))
				.putInt("due", o.optInt("due", -1))
				.putLong("pausedUntil", o.optLong("pausedUntil", 0))
				.apply();
			schedule(context);
		} catch (Exception ignored) { /* a malformed call changes nothing */ }
	}

	/** Set (or cancel) the alarm for the next scheduled time. */
	static void schedule(Context context) {
		SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
		AlarmManager am = context.getSystemService(AlarmManager.class);
		PendingIntent fire = PendingIntent.getBroadcast(context, 0, new Intent(context, Receiver.class).setAction("lh.REVIEW_REMINDER"),
			PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		// Paused: the first scheduled time after the pause ends.
		long from = Math.max(System.currentTimeMillis(), p.getLong("pausedUntil", 0));
		long next = nextTime(p.getString("days", ""), p.getString("time", ""), from);
		if (!p.getBoolean("notify", false) || next < 0) {
			am.cancel(fire);
			return;
		}
		am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, fire);
	}

	static long nextTime(String days, String time, long after) {
		if (days.isEmpty() || !time.matches("\\d\\d:\\d\\d")) return -1;
		int h = Integer.parseInt(time.substring(0, 2)), m = Integer.parseInt(time.substring(3));
		Calendar c = Calendar.getInstance();
		c.setTimeInMillis(after);
		c.set(Calendar.HOUR_OF_DAY, h);
		c.set(Calendar.MINUTE, m);
		c.set(Calendar.SECOND, 0);
		c.set(Calendar.MILLISECOND, 0);
		for (int i = 0; i <= 7; i++) {
			int weekday = c.get(Calendar.DAY_OF_WEEK) - 1; // 0 = Sunday, as on the web side
			if (days.indexOf((char) ('0' + weekday)) >= 0 && c.getTimeInMillis() > after) return c.getTimeInMillis();
			c.add(Calendar.DAY_OF_MONTH, 1);
		}
		return -1;
	}

	/** The alarm (and boot): post the reminder when due, then set the next one. */
	public static final class Receiver extends BroadcastReceiver {
		@Override public void onReceive(Context context, Intent intent) {
			if ("lh.REVIEW_REMINDER".equals(intent.getAction())) notifyNow(context);
			schedule(context);
		}
	}

	private static void notifyNow(Context context) {
		SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
		if (!p.getBoolean("notify", false) || System.currentTimeMillis() < p.getLong("pausedUntil", 0)) return;
		int due = p.getInt("due", -1);
		NotificationManager nm = context.getSystemService(NotificationManager.class);
		nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Review reminders", NotificationManager.IMPORTANCE_DEFAULT));
		Intent open = new Intent(context, MainActivity.class).putExtra(EXTRA_ROUTE, "/review").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		PendingIntent tap = PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		String text = due > 0 ? due + (due == 1 ? " card is" : " cards are") + " ready." : "See what's due today.";
		Notification n = new Notification.Builder(context, CHANNEL)
			.setContentTitle("Time for your reviews")
			.setContentText(text)
			.setSmallIcon(android.R.drawable.ic_popup_reminder)
			.setContentIntent(tap)
			.setAutoCancel(true)
			.build();
		nm.notify(2, n);
	}
}
