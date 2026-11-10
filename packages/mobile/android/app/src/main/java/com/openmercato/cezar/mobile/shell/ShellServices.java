package com.openmercato.cezar.mobile.shell;

import android.content.Context;
import android.content.pm.PackageManager;
import java.io.File;

/** One connector per process, kept where Android backup never looks. */
public final class ShellServices {
    private static ShellConnector connector;
    private static String token;

    private ShellServices() {}

    public static synchronized ShellConnector connector(Context context) {
        if (connector == null) {
            File directory = context.getApplicationContext().getNoBackupFilesDir();
            connector = new ShellConnector(new ServerListStore(directory),
                    new CredentialStore(directory, new KeystoreCipher()),
                    new HealthProbe(new HttpGet.Platform(), userAgentToken(context)));
        }
        return connector;
    }

    public static synchronized String userAgentToken(Context context) {
        if (token == null) {
            try {
                token = ShellUserAgent.token(context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName);
            } catch (PackageManager.NameNotFoundException e) {
                throw new IllegalStateException(e);
            }
        }
        return token;
    }
}
