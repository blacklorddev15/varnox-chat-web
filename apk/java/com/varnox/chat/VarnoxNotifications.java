package com.varnox.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;

/**
 * Notification plumbing: two channels (message alerts + the connection notice that keeps
 * the WebView alive in the background) and the code that turns a web-app alert into a
 * real notification.
 */
final class VarnoxNotifications {

    static final String CHANNEL_MESSAGES = "varnox_messages";
    static final String CHANNEL_CONNECTION = "varnox_connection";

    static final int ID_MESSAGES = 4201;
    static final int ID_CONNECTION = 4200;

    static final int GOLD = Color.parseColor("#D4A017");

    private VarnoxNotifications() {
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel messages = new NotificationChannel(
                CHANNEL_MESSAGES,
                context.getString(R.string.channel_messages),
                NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(context.getString(R.string.channel_messages_desc));
        messages.enableVibration(true);
        manager.createNotificationChannel(messages);

        NotificationChannel connection = new NotificationChannel(
                CHANNEL_CONNECTION,
                context.getString(R.string.channel_connection),
                NotificationManager.IMPORTANCE_LOW);
        connection.setDescription(context.getString(R.string.channel_connection_desc));
        connection.setShowBadge(false);
        manager.createNotificationChannel(connection);
    }

    /** Low-importance, ongoing notice that keeps the process (and the live connection) alive. */
    static Notification buildConnectionNotification(Context context) {
        PendingIntent intent = activityIntent(context, null);
        Notification.Builder builder = builder(context, CHANNEL_CONNECTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.connection_title))
                .setContentText(context.getString(R.string.connection_text))
                .setColor(GOLD)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(intent);
        return builder.build();
    }

    /** One notification per conversation (the web app passes the conversation as the title). */
    static void postMessage(Context context, String title, String body, String tag) {
        String conversation = title == null || title.trim().isEmpty()
                ? context.getString(R.string.app_name) : title.trim();
        String text = body == null || body.trim().isEmpty()
                ? context.getString(R.string.fallback_body) : body.trim();

        PendingIntent intent = activityIntent(context, tag);

        Notification.Builder builder = builder(context, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(conversation)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setColor(GOLD)
                .setAutoCancel(true)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setContentIntent(intent);

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        // tag = conversation, so a new message replaces the previous alert for that chat
        manager.notify(conversation, ID_MESSAGES, builder.build());
    }

    static void cancelMessage(Context context, String title) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(title, ID_MESSAGES);
    }

    private static PendingIntent activityIntent(Context context, String tag) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (tag != null) intent.putExtra(MainActivity.EXTRA_NOTIFICATION_TAG, tag);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, tag == null ? 0 : tag.hashCode(), intent, flags);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder builder(Context context, String channelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(context, channelId);
        }
        return new Notification.Builder(context);
    }

    /** True when the app is allowed to post notifications at all. */
    static boolean allowed(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }
}
