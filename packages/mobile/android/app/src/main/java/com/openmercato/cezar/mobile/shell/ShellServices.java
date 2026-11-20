package com.openmercato.cezar.mobile.shell;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;
import com.openmercato.cezar.mobile.BuildConfig;
import com.openmercato.cezar.mobile.shell.push.BadgeRefresh;
import com.openmercato.cezar.mobile.shell.push.CezarPush;
import com.openmercato.cezar.mobile.shell.push.GrantClient;
import com.openmercato.cezar.mobile.shell.push.OkHttpPushRelay;
import com.openmercato.cezar.mobile.shell.push.PushCoordinator;
import com.openmercato.cezar.mobile.shell.push.PushStore;
import com.openmercato.cezar.mobile.shell.push.SignalStream;
import com.openmercato.cezar.mobile.shell.push.TokenSource;
import com.openmercato.cezar.mobile.shell.relay.AccountClient;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
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
    private static StartupLog startupLog;
    private static BadgeRefresh badges;
    private static final Object PROBE_LOCK = new Object();
    private static final ExecutorService PROBE_WORK = Executors.newCachedThreadPool();
    private static final ScheduledExecutorService PROBE_BOUNDS = Executors.newSingleThreadScheduledExecutor();
    private static final Map<String, DeviceProbes.Reading> PROBE_READINGS = new ConcurrentHashMap<>();
    private static List<Consumer<RuntimeException>> probeWaiters;

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

    /**
     * Cold start of a relay server whose bundle is on the phone: connect now, while the WebView and the
     * connect page load. Not behind the app lock, which must open nothing before it is answered.
     */
    public static void prewarm(Context context) {
        Context app = context.getApplicationContext();
        if (AppLock.get(app).enabled()) return;
        Thread thread = new Thread(() -> {
            ShellConnector shell = connector(app);
            String last = shell.lastUsedId();
            ServerRecord server = last == null ? null : shell.server(last);
            if (server == null || server.relay == null) return;
            RelayConnections connections = relay(app);
            if (connections.quickPath(server) != null) connections.prewarm(server);
        }, "cezar-prewarm");
        thread.setDaemon(true);
        thread.start();
    }

    /** Set by the application, which owns the notifications the rounds clear. */
    public static synchronized void setBadges(BadgeRefresh refresh) {
        badges = refresh;
    }

    /** Null before the application set it. */
    public static synchronized BadgeRefresh badges() {
        return badges;
    }

    /** The last probe round's readings, by server id: what Your cezars draws. */
    public static Map<String, DeviceProbes.Reading> probeReadings() {
        return PROBE_READINGS;
    }

    /**
     * One probe round over every saved cezar at a time; a call during one joins it. Your cezars and the badge rounds
     * share it, because a round's end cools every warm link and would cut another round's probes short (B1).
     * `done` gets null, or the error that stopped the round.
     */
    public static void probeRound(Context context, Consumer<RuntimeException> done) {
        synchronized (PROBE_LOCK) {
            if (probeWaiters != null) {
                probeWaiters.add(done);
                return;
            }
            probeWaiters = new ArrayList<>();
            probeWaiters.add(done);
        }
        Context app = context.getApplicationContext();
        PROBE_WORK.execute(() -> {
            try {
                ShellConnector shell = connector(app);
                RelayConnections relay = relay(app);
                DeviceProbes probes = new DeviceProbes(DeviceProbes.relayProbe(relay, PROBE_WORK),
                        DeviceProbes.directProbe(shell, server -> server.url == null ? null : CookieManager.getInstance().getCookie(server.url), PROBE_WORK),
                        relay::cool, (ms, work) -> PROBE_BOUNDS.schedule(work, ms, TimeUnit.MILLISECONDS),
                        (id, answer) -> shell.sawHealth(id, answer, System.currentTimeMillis()), PROBE_READINGS::put);
                probes.whenSettled(() -> {
                    probes.stop(null);
                    endProbeRound(null);
                });
                probes.start(shell.list());
            } catch (RuntimeException e) {
                endProbeRound(e);
            }
        });
    }

    private static void endProbeRound(RuntimeException error) {
        List<Consumer<RuntimeException>> waiters;
        synchronized (PROBE_LOCK) {
            waiters = probeWaiters;
            probeWaiters = null;
        }
        if (waiters != null) for (Consumer<RuntimeException> each : waiters) each.accept(error);
    }

    public static synchronized RelayConnections relay(Context context) {
        if (relay == null) relay = new RelayConnections(transport(), deviceKeys(context), userAgentToken(context),
                new File(context.getApplicationContext().getNoBackupFilesDir(), "bundles"), installStamp(context));
        return relay;
    }

    /** The phone's clock and formats, for "Offline since …". */
    public static DeviceSwitch.Clock clock(Context context) {
        java.text.DateFormat time = android.text.format.DateFormat.getTimeFormat(context);
        java.text.DateFormat day = new java.text.SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "d MMM"), java.util.Locale.getDefault());
        return new DeviceSwitch.Clock(System.currentTimeMillis(), java.util.TimeZone.getDefault(), time, day);
    }

    public static synchronized StartupLog startupLog(Context context) {
        if (startupLog == null) startupLog = new StartupLog(new File(context.getApplicationContext().getNoBackupFilesDir(), "startup.log"), System::currentTimeMillis);
        return startupLog;
    }

    /** Changes with every install of the app, so a bundle another build kept is never painted. */
    public static String installStamp(Context context) {
        try {
            long updated = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
            return BuildConfig.VERSION_CODE + "-" + updated;
        } catch (PackageManager.NameNotFoundException e) {
            return String.valueOf(BuildConfig.VERSION_CODE);
        }
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

    /** The relay account calls (RELAY_PROTOCOL.md § 18), signed by the server's device key. */
    public static AccountClient accounts() {
        return new AccountClient(new OkHttpPushRelay(), System::currentTimeMillis);
    }

    public static DeviceKeys deviceKeysFor(Context context, String serverId) {
        return deviceKeys(context).get(serverId);
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
