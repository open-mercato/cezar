package com.openmercato.cezar.mobile.shell;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import com.openmercato.cezar.mobile.BuildConfig;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeyStore;
import com.openmercato.cezar.mobile.shell.relay.OkHttpTransport;
import com.openmercato.cezar.mobile.shell.relay.PairingFlow;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.SocketTransport;
import java.io.File;

/** One connector per process, kept where Android backup never looks. */
public final class ShellServices {
    private static ShellConnector connector;
    private static String token;
    private static RelayConnections relay;
    private static DeviceKeyStore deviceKeys;
    private static SocketTransport transport;
    private static PairingFlow pairing;
    private static String lastPaired;

    private ShellServices() {}

    public static synchronized ShellConnector connector(Context context) {
        if (connector == null) {
            File directory = context.getApplicationContext().getNoBackupFilesDir();
            connector = new ShellConnector(new ServerListStore(directory),
                    new CredentialStore(directory, new KeystoreCipher()),
                    new HealthProbe(new HttpGet.Platform(), userAgentToken(context)), relay(context));
        }
        return connector;
    }

    public static synchronized RelayConnections relay(Context context) {
        if (relay == null) relay = new RelayConnections(transport(), deviceKeys(context), userAgentToken(context));
        return relay;
    }

    public static synchronized PairingFlow pairing(Context context) {
        if (pairing == null) {
            Context app = context.getApplicationContext();
            pairing = new PairingFlow(transport(), Build.MODEL, BuildConfig.DEBUG, (origin, state, keys) -> {
                ShellConnector shell = connector(app);
                String id = shell.relayServerId(state.cezarId);
                deviceKeys(app).put(id, keys);
                shell.saveRelayServer(id, state.label, new RelayFields(origin.origin, state.cezarId,
                        com.openmercato.cezar.mobile.shell.relay.Bytes.base64url(state.cezarStatic), keys.deviceId(), 0));
                setLastPaired(id);
            });
        }
        return pairing;
    }

    private static synchronized void setLastPaired(String id) {
        lastPaired = id;
    }

    /** The server the last approval saved. */
    public static synchronized String lastPaired() {
        return lastPaired;
    }

    private static SocketTransport transport() {
        if (transport == null) transport = new OkHttpTransport();
        return transport;
    }

    private static synchronized DeviceKeyStore deviceKeys(Context context) {
        if (deviceKeys == null) deviceKeys = new DeviceKeyStore(context.getApplicationContext().getNoBackupFilesDir(), new KeystoreCipher());
        return deviceKeys;
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
