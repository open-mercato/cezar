package com.openmercato.cezar.mobile.push;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.openmercato.cezar.mobile.shell.ShellServices;

/** Firebase adapter. In the background the system shows the relay's fixed notification; this covers the foreground. */
public final class CezarMessagingService extends FirebaseMessagingService {
    /** Runs on FCM's worker thread. The token itself is never kept or logged here. */
    @Override
    public void onNewToken(@NonNull String token) {
        ShellServices.push(this).onNewToken(ShellServices.connector(this).list());
    }

    /** Our own fixed text only, never the message's: the relay forwards `s` and a count, nothing else. */
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        RemoteMessage.Notification notification = message.getNotification();
        Integer count = notification == null ? null : notification.getNotificationCount();
        PushNotifier.post(this, message.getData().get(PushNotifier.EXTRA_CEZAR_ID), count == null ? 0 : count);
    }
}
