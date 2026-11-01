package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.HealthAnswer;
import com.openmercato.cezar.mobile.shell.HealthProbe;
import com.openmercato.cezar.mobile.shell.RelayFields;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import java.io.IOException;

/** The single relay connection and single listener a process may hold: only the server on screen has one (spec). */
public final class RelayConnections implements ShellConnector.RelayPort {
    private static final long SETTLE_MS = 12000;
    private static final long GOODBYE_MS = 8000;

    private final SocketTransport transport;
    private final DeviceKeyStore keys;
    private final String userAgent;
    private String serverId;
    private String deviceId;
    private RelayLink link;
    private LoopbackProxy proxy;

    public RelayConnections(SocketTransport transport, DeviceKeyStore keys, String userAgent) {
        this.transport = transport;
        this.keys = keys;
        this.userAgent = userAgent;
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
        LoopbackProxy next = new LoopbackProxy(current::session, userAgent);
        next.open(server.relay.port);
        proxy = next;
        return next;
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
}
