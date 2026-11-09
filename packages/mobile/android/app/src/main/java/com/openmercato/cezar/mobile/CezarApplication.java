package com.openmercato.cezar.mobile;

import android.app.Application;
import com.openmercato.cezar.mobile.push.FcmTokenSource;
import com.openmercato.cezar.mobile.push.PushNotifier;
import com.openmercato.cezar.mobile.shell.AppLock;
import com.openmercato.cezar.mobile.shell.ShellServices;

/** Exists so the lock watches every activity, including one restored first after process death (spec QR3). */
public final class CezarApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AppLock.get(this);
        // Before any activity, so the shell sees push as it is; the shell itself never names Firebase.
        ShellServices.setTokenSource(new FcmTokenSource(this));
        PushNotifier.createChannel(this);
    }
}
