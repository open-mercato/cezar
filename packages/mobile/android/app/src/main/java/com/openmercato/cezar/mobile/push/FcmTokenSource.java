package com.openmercato.cezar.mobile.push;

import android.content.Context;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.openmercato.cezar.mobile.shell.push.TokenSource;
import java.io.IOException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Firebase adapter. Without `google-services.json` no FirebaseApp starts, and push is simply off. */
public final class FcmTokenSource implements TokenSource {
    private static final long TIMEOUT_SECONDS = 30;

    private final Context context;

    public FcmTokenSource(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public boolean available() {
        return !FirebaseApp.getApps(context).isEmpty();
    }

    /** Auto-init is off in the manifest, so this is the first moment FCM registers the phone. */
    @Override
    public String token() throws IOException {
        if (!available()) throw new IOException("push is unavailable");
        try {
            return Tasks.await(FirebaseMessaging.getInstance().getToken(), TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException | TimeoutException e) {
            // The cause may quote the request: say only that it failed.
            throw new IOException("no push token");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("no push token");
        }
    }
}
