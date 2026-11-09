package com.openmercato.cezar.mobile.shell;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import com.openmercato.cezar.mobile.BuildConfig;
import com.openmercato.cezar.mobile.shell.push.CezarPush;
import com.openmercato.cezar.mobile.shell.push.GrantClient;
import com.openmercato.cezar.mobile.shell.push.OkHttpPushRelay;
import com.openmercato.cezar.mobile.shell.push.PushCoordinator;
import com.openmercato.cezar.mobile.shell.push.PushStore;
import com.openmercato.cezar.mobile.shell.push.SignalStream;
import com.openmercato.cezar.mobile.shell.push.TokenSource;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeyStore;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import com.openmercato.cezar.mobile.shell.relay.OkHttpTransport;
import com.openmercato.cezar.mobile.shell.relay.PairingFlow;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.SocketTransport;
import com.openmercato.cezar.mobile.shell.relay.TunnelGetStream;
import com.openmercato.cezar.mobile.shell.relay.TunnelHttp;
import com.openmercato.cezar.mobile.shell.relay.TunnelSession;
import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/** One connector per process, kept where Android backup never looks. */
public final class ShellServices {
    private static ShellConnector connector;
    private static String token;
    private static RelayConnections relay;
    private static DeviceKeyStore deviceKeys;
    private static SocketTransport transport;
    private static PairingFlow pairing;
    private static String lastPaired;
    private static TokenSource tokens = TokenSource.NONE;
    private static PushCoordinator push;

    private ShellServices() {}

    public static synchronized ShellConnector connector(Context context) {
        if (connector == null) {
            File directory = context.getApplicationContext().getNoBackupFilesDir();
            connector = new ShellConnector(new ServerListStore(directory),
                    new CredentialStore(directory, new KeystoreCipher()),
                    new HealthProbe(new HttpGet.Platform(), userAgentToken(context)), relay(context), push(context)::forget);
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
                String id = shell.relayServerId(state.cezarId, com.openmercato.cezar.mobile.shell.relay.Bytes.base64url(state.cezarStatic));
                deviceKeys(app).put(id, keys);
                shell.saveRelayServer(id, state.label, new RelayFields(origin.origin, state.cezarId,
                        com.openmercato.cezar.mobile.shell.relay.Bytes.base64url(state.cezarStatic), keys.deviceId(), 0));
                setLastPaired(id);
            });
        }
        return pairing;
    }

    /** Set once by the application, before anything asks: the shell never names the push service itself. */
    public static synchronized void setTokenSource(TokenSource source) {
        tokens = source;
    }

    public static synchronized PushCoordinator push(Context context) {
        if (push == null) {
            Context app = context.getApplicationContext();
            push = new PushCoordinator(new PushStore(app.getNoBackupFilesDir()), tokens, new GrantClient(new OkHttpPushRelay(), System::currentTimeMillis),
                    new PushCoordinator.Keys() {
                        @Override
                        public DeviceKeys get(String serverId) {
                            return deviceKeys(app).get(serverId);
                        }

                        @Override
                        public void delete(String serverId) {
                            deviceKeys(app).delete(serverId);
                        }
                    }, System::currentTimeMillis, new SecureRandom());
        }
        return push;
    }

    /** The push route, asked inside this session. */
    public static CezarPush cezarPush(Context context, Supplier<TunnelSession> session) {
        return new CezarPush(new TunnelHttp(session)::send, userAgentToken(context));
    }

    /** Stage 1's signal stream, opened inside whichever session is up at the time. */
    public static SignalStream.Source signals(Context context, Supplier<TunnelSession> session) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "text/event-stream");
        headers.put("User-Agent", userAgentToken(context));
        return () -> {
            TunnelGetStream stream = TunnelGetStream.open(session.get(), SignalStream.PATH, headers);
            return new SignalStream.Connection() {
                @Override
                public int status() {
                    return stream.status();
                }

                @Override
                public byte[] read(long timeoutMs) throws IOException {
                    return stream.read(timeoutMs);
                }

                @Override
                public void close() {
                    stream.close();
                }
            };
        };
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
