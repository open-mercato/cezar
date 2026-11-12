package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.HealthAnswer;
import com.openmercato.cezar.mobile.shell.HealthProbe;
import com.openmercato.cezar.mobile.shell.RelayFields;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import java.io.File;
import java.io.IOException;

/** The single relay connection and single listener a process may hold: only the server on screen has one (spec). */
public final class RelayConnections implements ShellConnector.RelayPort {
    private static final long SETTLE_MS = 12000;
    private static final long GOODBYE_MS = 8000;
    /** Per server: the cockpit's bundle is a few MB, and an old build's files age out first. */
    private static final long BUNDLE_BYTES = 40L * 1024 * 1024;
    private static final long PREWARM_MS = 20000;

    private final SocketTransport transport;
    private final DeviceKeyStore keys;
    private final String userAgent;
    /** App-private, no-backup. Null keeps every request in the tunnel. */
    private final File bundles;
    private String serverId;
    private String deviceId;
    private RelayLink link;
    private LoopbackProxy proxy;

    public RelayConnections(SocketTransport transport, DeviceKeyStore keys, String userAgent) {
        this(transport, keys, userAgent, null);
    }

    public RelayConnections(SocketTransport transport, DeviceKeyStore keys, String userAgent, File bundles) {
        this.transport = transport;
        this.keys = keys;
        this.userAgent = userAgent;
        this.bundles = bundles;
    }

    /** The server's cached cockpit bundle, or null with no cache. Its id is a UUID the app made. */
    public BundleCache bundle(String id) {
        if (bundles == null || id == null || !id.matches("[A-Za-z0-9-]{1,64}")) return null;
        return new BundleCache(new File(bundles, id), BUNDLE_BYTES);
    }

    /** The link for this server. Asking for another closes the first, listener included. */
    public synchronized RelayLink link(ServerRecord server) {
        // Pairing the same cezar again keeps the row but changes the device, so the old link holds dead keys.
        if (link != null && server.id.equals(serverId) && server.relay.deviceId.equals(deviceId)) return link;
        release();
        DeviceKeys deviceKeys = keys.get(server.id);
        if (deviceKeys == null) return null;
        RelayFields relay = server.relay;
        byte[] pinned = Bytes.fromBase64url(relay.cezarKey, 32);
        link = new RelayLink(transport, new RelayLink.Target(socketOrigin(relay.origin), relay.cezarId, relay.deviceId, pinned, deviceKeys), System::currentTimeMillis);
        serverId = server.id;
        deviceId = relay.deviceId;
        return link;
    }

    private static String socketOrigin(String origin) {
        return origin.startsWith("https") ? "wss" + origin.substring(5) : "ws" + origin.substring(4);
    }

    /** Opens the listener for the server on screen, on its saved port when that is free. */
    public synchronized LoopbackProxy openProxy(ServerRecord server) throws IOException {
        RelayLink current = link(server);
        if (current == null) throw new IOException("no device keys");
        if (proxy != null) {
            proxy.close();
            proxy = null;
        }
        LoopbackProxy next = new LoopbackProxy(current::session, userAgent, bundle(server.id));
        next.open(server.relay.port);
        proxy = next;
        return next;
    }

    /**
     * A start that will skip the probe: the relay connect and handshake run beside the app's own
     * start-up. Stopped again if no server view takes the link within PREWARM_MS.
     */
    public void prewarm(ServerRecord server) {
        RelayLink warm = link(server);
        if (warm == null) return;
        warm.start();
        Thread unused = new Thread(() -> {
            try {
                Thread.sleep(PREWARM_MS);
            } catch (InterruptedException e) {
                return;
            }
            synchronized (this) {
                if (proxy == null && link == warm) warm.stop();
            }
        }, "cezar-prewarm-stop");
        unused.setDaemon(true);
        unused.start();
    }

    /** Whether this view's listener is still the process's one: a newer view may have taken the connection. */
    public synchronized boolean holds(LoopbackProxy opened) {
        return opened != null && opened == proxy;
    }

    /** Called when a server view goes away. A newer view may hold the connection by then, and it stays. */
    public synchronized void release(LoopbackProxy opened) {
        if (opened == proxy) release();
    }

    public synchronized void release() {
        if (proxy != null) proxy.close();
        proxy = null;
        if (link != null) link.dispose();
        link = null;
        serverId = null;
        deviceId = null;
    }

    @Override
    public HealthAnswer probe(ServerRecord server) {
        RelayLink current = link(server);
        if (current == null) return HealthAnswer.of(HealthAnswer.Kind.DEVICE_REMOVED, 0);
        current.start();
        RelayStatus status;
        try {
            status = current.awaitSettled(SETTLE_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            status = current.status();
        }
        HealthAnswer answer = status.kind == RelayStatus.Kind.READY
                ? new HealthProbe(new TunnelHttpGet(current::session), userAgent).probePath()
                : HealthAnswer.fromRelay(status.kind == RelayStatus.Kind.CONNECTING && current.relayAnswered() ? "NOT_ANSWERING" : status.kind.name(),
                        (int) Math.ceil(status.retryAfterSeconds / 60.0));
        // Foreground only: nothing holds a socket behind a connect-page error screen.
        if (answer.kind != HealthAnswer.Kind.CEZAR) current.stop();
        return answer;
    }

    @Override
    public void goodbye(ServerRecord server) {
        RelayLink current = link(server);
        if (current == null) return;
        current.start();
        try {
            if (current.awaitSettled(GOODBYE_MS).kind == RelayStatus.Kind.READY) current.goodbye();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        release();
    }

    @Override
    public void forgetKeys(String id) {
        keys.delete(id);
    }

    @Override
    public String quickPath(ServerRecord server) {
        BundleCache cache = bundle(server.id);
        return cache != null && cache.hasShell() ? cache.startPath() : null;
    }

    @Override
    public void opened(ServerRecord server, String path) {
        BundleCache cache = bundle(server.id);
        if (cache != null) cache.saveStartPath(path);
    }

    @Override
    public void forgetBundle(String id) {
        BundleCache cache = bundle(id);
        if (cache != null) cache.clear();
    }
}
