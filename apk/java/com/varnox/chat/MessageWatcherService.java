package com.varnox.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Polls the app's own conversation list so a new message raises a real Android notification
 * even when the WebView is in the background or the app has been swiped away.
 *
 * Why polling: Android WebView implements neither the Web Notifications API nor the Web Push
 * API, so there is no way for a server to wake this app. Until a native push backend exists,
 * polling is the only mechanism that works with the app closed. It reuses the WebView's own
 * session cookie, so it sees exactly the conversations the signed-in user sees.
 */
public class MessageWatcherService extends Service {

    static final String ACTION_START = "com.varnox.chat.action.START_WATCH";
    static final String ACTION_STOP = "com.varnox.chat.action.STOP_WATCH";

    private static final String WATCH_CHANNEL_ID = "varnox_watch";
    private static final int WATCH_NOTIFICATION_ID = 1;
    private static final long POLL_INTERVAL_MS = 30_000L;
    private static final long FIRST_POLL_DELAY_MS = 5_000L;
    private static final String PREFS = "varnox_watcher";
    private static final String PREF_SEEN = "seen_unread";
    private static final int MAX_BODY = 180;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile boolean running;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!running) {
                return;
            }
            checkForNewMessages();
            if (running) {
                handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopWatching();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            startForegroundCompat();
            handler.postDelayed(poll, FIRST_POLL_DELAY_MS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(poll);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------
    // Notifications
    // ------------------------------------------------------------------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        if (nm.getNotificationChannel(WATCH_CHANNEL_ID) == null) {
            NotificationChannel watch = new NotificationChannel(
                    WATCH_CHANNEL_ID, "Background message check", NotificationManager.IMPORTANCE_MIN);
            watch.setDescription("Keeps Varnox connected so new messages can reach you");
            watch.setShowBadge(false);
            nm.createNotificationChannel(watch);
        }
    }

    /** Foreground services must show something; keep it as quiet as Android allows. */
    private void startForegroundCompat() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, WATCH_CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_varnox)
                .setContentTitle("Varnox Chat")
                .setContentText("Watching for new messages")
                .setContentIntent(contentIntent)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_MIN);
        }
        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(WATCH_NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(WATCH_NOTIFICATION_ID, notification);
        }
    }

    private void notifyMessage(String conversationId, String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !notificationsAllowed()) {
            return;
        }

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int id = Math.abs(conversationId.hashCode());
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, NotificationBridge.CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_varnox)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setColor(0xFF4F8BFF);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
            builder.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            nm.notify(conversationId, id, builder.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked between the check and the call.
        }
    }

    private boolean notificationsAllowed() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Polling
    // ------------------------------------------------------------------

    private void checkForNewMessages() {
        final String cookie = CookieManager.getInstance().getCookie(MainActivity.START_URL);
        if (cookie == null || cookie.isEmpty()) {
            // Signed out (or never signed in): there is nothing to watch.
            stopWatching();
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                String payload = fetchConversations(cookie);
                if (payload == null) {
                    return;
                }
                try {
                    compareAndNotify(payload);
                } catch (Exception ignored) {
                    // A malformed payload must never crash the watcher.
                }
            }
        }, "varnox-watch").start();
    }

    private String fetchConversations(String cookie) {
        HttpURLConnection connection = null;
        try {
            String input = URLEncoder.encode("{\"0\":{\"json\":null}}", "UTF-8");
            String url = MainActivity.START_URL + "api/trpc/conversations.list?batch=1&input=" + input;
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200) {
                return null;
            }
            InputStream stream = connection.getInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
            StringBuilder text = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                text.append(line);
            }
            reader.close();
            return text.toString();
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** Compares unread counts with the previous poll and notifies only what grew. */
    private void compareAndNotify(String payload) throws Exception {
        JSONArray batch = new JSONArray(payload);
        if (batch.length() == 0) {
            return;
        }
        JSONObject data = batch.getJSONObject(0).optJSONObject("result");
        if (data == null) {
            return;
        }
        JSONArray conversations = data.optJSONObject("data").optJSONArray("json");
        if (conversations == null) {
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(PREF_SEEN, "");
        Map<String, Integer> previous = parseSeen(stored);
        Map<String, Integer> current = new HashMap<>();
        boolean firstRun = stored.isEmpty();

        for (int i = 0; i < conversations.length(); i++) {
            JSONObject conversation = conversations.getJSONObject(i);
            String id = conversation.optString("id", "");
            if (id.isEmpty()) {
                continue;
            }
            int unread = conversation.optInt("unreadCount", 0);
            current.put(id, unread);

            int before = previous.containsKey(id) ? previous.get(id) : 0;
            if (firstRun || unread <= before) {
                continue;
            }

            JSONObject last = conversation.optJSONObject("lastMessage");
            JSONObject other = conversation.optJSONObject("otherMember");
            String title = conversation.optString("title", "");
            if (other != null && !other.isNull("name")) {
                title = other.optString("name", title);
            }
            if (title.isEmpty()) {
                title = "New message";
            }
            String body = last != null ? last.optString("body", "") : "";
            if (body.isEmpty()) {
                body = unread > 1 ? unread + " new messages" : "Sent you a message";
            } else if (unread > 1) {
                body = body + "  (+" + (unread - 1) + " more)";
            }
            notifyMessage(id, title, clip(body));
        }

        prefs.edit().putString(PREF_SEEN, serializeSeen(current)).apply();
    }

    private Map<String, Integer> parseSeen(String stored) {
        Map<String, Integer> seen = new HashMap<>();
        if (stored == null || stored.isEmpty()) {
            return seen;
        }
        String[] entries = stored.split(",");
        for (String entry : entries) {
            int split = entry.lastIndexOf(':');
            if (split <= 0) {
                continue;
            }
            try {
                seen.put(entry.substring(0, split), Integer.parseInt(entry.substring(split + 1)));
            } catch (NumberFormatException ignored) {
                // skip malformed entry
            }
        }
        return seen;
    }

    private String serializeSeen(Map<String, Integer> counts) {
        StringBuilder text = new StringBuilder();
        for (Iterator<Map.Entry<String, Integer>> it = counts.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, Integer> entry = it.next();
            text.append(entry.getKey()).append(':').append(entry.getValue());
            if (it.hasNext()) {
                text.append(',');
            }
        }
        return text.toString();
    }

    private static String clip(String value) {
        String trimmed = value == null ? "" : value.trim();
        return trimmed.length() <= MAX_BODY ? trimmed : trimmed.substring(0, MAX_BODY - 1) + "\u2026";
    }

    private void stopWatching() {
        running = false;
        handler.removeCallbacks(poll);
        stopForeground(true);
        stopSelf();
    }

    // ------------------------------------------------------------------
    // Control
    // ------------------------------------------------------------------

    static void start(Context context) {
        Intent intent = new Intent(context, MessageWatcherService.class).setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
            // Background start restrictions: the next foreground launch retries.
        }
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, MessageWatcherService.class).setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (Exception ignored) {
            context.stopService(new Intent(context, MessageWatcherService.class));
        }
    }
}
