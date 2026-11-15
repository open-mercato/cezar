package com.openmercato.cezar.mobile.push;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellServices;
import com.openmercato.cezar.mobile.shell.push.ForegroundServers;
import com.openmercato.cezar.mobile.shell.push.PushTap;
import com.openmercato.cezar.mobile.shell.push.PushText;

/**
 * Firebase adapter. The relay sends a high-priority data-only message (RELAY_PROTOCOL.md § 7), so every
 * push lands here, even in the background, and is named on the phone (switcher spec, "Push").
 */
public final class CezarMessagingService extends FirebaseMessagingService {
    /** Runs on FCM's worker thread. The token itself is never kept or logged here. */
    @Override
    public void onNewToken(@NonNull String token) {
        ShellServices.push(this).onNewToken(ShellServices.connector(this).list());
    }

    /** Our own text only, never the message's: the relay forwards `s` and a count, nothing else. */
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String cezarId = message.getData().get(PushNotifier.EXTRA_CEZAR_ID);
        ShellConnector connector = ShellServices.connector(this);
        ServerRecord server = PushTap.serverFor(cezarId, connector.list());
        if (server == null) return;
        RemoteMessage.Notification notification = message.getNotification();
        Integer count = PushText.count(message.getData(), notification == null ? null : notification.getNotificationCount());
        // Kept even when nothing is shown: the badge sums what the phone last heard from each computer.
        if (count != null) {
            try {
                connector.pushedWaiting(server.id, count);
            } catch (IllegalStateException e) {
                // A full disk loses the count, never the notification.
            }
        }
        // The same checks as Stage 1: not over that server's own page, and not after its switch went off.
        if (!ForegroundServers.SHARED.shouldNotify(server.id) || !ShellServices.push(this).enabled(server.id)) return;
        PushNotifier.post(this, cezarId);
    }
}
