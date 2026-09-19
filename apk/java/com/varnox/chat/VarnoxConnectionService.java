package com.varnox.chat;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground service that keeps the app process alive so the WebView's live connection
 * keeps delivering messages while the app is in the background.
 *
 * This is deliberately not a push service: without server-side push credentials (FCM or an
 * Expo push token issued to the project) a WebView shell can only stay online, not be
 * woken up. Alerts therefore arrive while the app is running in the background and stop if
 * the user force-stops or swipes the app away.
 */
public class VarnoxConnectionService extends Service {

    /** Set by the activity while a call is running, so the service can declare the right type. */
    public static final String EXTRA_IN_CALL = "in_call";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        VarnoxNotifications.ensureChannels(this);
        Notification notification = VarnoxNotifications.buildConnectionNotification(this);

        boolean inCall = intent != null && intent.getBooleanExtra(EXTRA_IN_CALL, false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 14+ refuses microphone capture from a dataSync service, so a call has to
            // say what it is. The type has to match the work actually happening or the system
            // throws, which is why it follows the call rather than being set once.
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (inCall) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
            startForeground(VarnoxNotifications.ID_CONNECTION, notification, type);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(VarnoxNotifications.ID_CONNECTION, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(VarnoxNotifications.ID_CONNECTION, notification);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
