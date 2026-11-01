package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One phone socket and the session on it (RELAY_PROTOCOL.md §§ 3, 4, 10). Every event runs on one
 * thread, so the state machine has no locks. Foreground only: {@link #stop()} closes with 1000.
 */
public final class RelayLink {
    public interface Listener {
        void status(RelayStatus status);
    }

    /** What pairing pinned. */
    public static final class Target {
        final String socketOrigin;
        final String cezarId;
        final String deviceId;
        final byte[] cezarStatic;
        final DeviceKeys keys;

        public Target(String socketOrigin, String cezarId, String deviceId, byte[] cezarStatic, DeviceKeys keys) {
            this.socketOrigin = socketOrigin;
            this.cezarId = cezarId;
            this.deviceId = deviceId;
            this.cezarStatic = cezarStatic;
            this.keys = keys;
        }
    }

    static final int FRAME_FLOOR = 16384;
    static final int FRAME_DEFAULT = 65552;
    private static final long PING_EVERY_MS = 45000;
    private static final long PONG_WAIT_MS = 15000;
    private static final long KK_WAIT_MS = 10000;
    private static final long HELLO_WAIT_MS = 15000;
    private static final long RESET_ATTEMPTS_AFTER_MS = 60000;
    private static final int SILENT_KK_LIMIT = 3;
    /** The AEAD tag: what sets a transport message's length class apart from a `KK` reply's (§ 10). */
    private static final int TRANSPORT_OVERHEAD = 16;
    private static final byte[] PROLOGUE_LABEL = Bytes.ascii("cezar-session-v1");

    private final SocketTransport transport;
    private final Target target;
    private final LongSupplier clock;
    private final Random random = new Random();
    private final ScheduledExecutorService actor;
    private final Object statusLock = new Object();
    private volatile RelayStatus status = RelayStatus.of(RelayStatus.Kind.IDLE);
    private volatile TunnelSession session;
    private volatile Listener listener;
    private volatile boolean relayAnswered;

    private boolean running;
    private int epoch;
    private SocketTransport.Connection socket;
    private NoiseHandshake handshake;
    private int frameBytes = FRAME_DEFAULT;
    private int attempts;
    private long clockOffsetSeconds;
    private boolean proofRetried;
    private long closingRetryAfter = -1;
    private long connectedAt;
    private boolean pongPending;
    private boolean helloSeen;
    private int silentHandshakes;

    public RelayLink(SocketTransport transport, Target target, LongSupplier clock) {
        this(transport, target, clock, Executors.newSingleThreadScheduledExecutor(run -> {
            Thread thread = new Thread(run, "cezar-relay-link");
            thread.setDaemon(true);
            return thread;
        }));
    }

    RelayLink(SocketTransport transport, Target target, LongSupplier clock, ScheduledExecutorService actor) {
        this.transport = transport;
        this.target = target;
        this.clock = clock;
        this.actor = actor;
    }

    public void setListener(Listener value) {
        listener = value;
        if (value != null) value.status(status);
    }

    public RelayStatus status() {
        return status;
    }

    public TunnelSession session() {
        return session;
    }

    /** A `hello` arrived, so a wait that ran out was not the relay's silence. */
    public boolean relayAnswered() {
        return relayAnswered;
    }

    public void start() {
        // Set here, not on the actor: a caller's awaitSettled must not read the old IDLE as an answer.
        if (status.kind == RelayStatus.Kind.IDLE) setStatus(RelayStatus.of(RelayStatus.Kind.CONNECTING));
        actor.execute(() -> {
            if (running) return;
            running = true;
            attempts = 0;
            connect();
        });
    }

    public void stop() {
        actor.execute(() -> {
            running = false;
            dropSocket();
            setStatus(RelayStatus.of(RelayStatus.Kind.IDLE));
        });
    }

    /** A Retry button: skips the wait, and leaves any terminal state. */
    public void retryNow() {
        actor.execute(() -> {
            running = true;
            attempts = 0;
            proofRetried = false;
            dropSocket();
            setStatus(RelayStatus.of(RelayStatus.Kind.CONNECTING));
            connect();
        });
    }

    /** Stops for good. This link is never started again. */
    public void dispose() {
        stop();
        actor.execute(actor::shutdown);
    }

    /** Forget server: `CLOSE` `goodbye` if a session is live (§ 10.1), then the socket closes. */
    public void goodbye() {
        actor.execute(() -> {
            TunnelSession live = session;
            if (live != null) live.close(TunnelFrame.CLOSE_GOODBYE);
            running = false;
            dropSocket();
            setStatus(RelayStatus.of(RelayStatus.Kind.IDLE));
        });
    }

    /** Waits for the first answer after {@link #start()}; `CONNECTING` means none came in time. */
    public RelayStatus awaitSettled(long timeoutMs) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        synchronized (statusLock) {
            while (status.kind == RelayStatus.Kind.CONNECTING) {
                long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (left <= 0) break;
                statusLock.wait(left);
            }
            return status;
        }
    }

    private void setStatus(RelayStatus next) {
        synchronized (statusLock) {
            status = next;
            statusLock.notifyAll();
        }
        Listener current = listener;
        if (current != null) current.status(next);
    }

    private void connect() {
        if (!running || socket != null) return;
        int mine = ++epoch;
        long time = clock.getAsLong() / 1000 + clockOffsetSeconds;
        Map<String, String> headers = RelayIds.phoneHeaders(target.keys.ed25519Seed, target.cezarId, target.deviceId, time);
        String url = target.socketOrigin + "/v1/phone/" + target.cezarId + "/" + target.deviceId;
        socket = transport.connect(url, headers, new SocketTransport.Events() {
            @Override
            public void opened() {
                post(mine, RelayLink.this::onOpen);
            }

            @Override
            public void text(String text) {
                post(mine, () -> onText(text));
            }

            @Override
            public void binary(byte[] bytes) {
                post(mine, () -> onBinary(bytes));
            }

            @Override
            public void closed(int code) {
                post(mine, () -> onClosed(code));
            }

            @Override
            public void failed(int httpStatus, String code, long retryAfter, long date) {
                post(mine, () -> onRefused(httpStatus, code, retryAfter, date));
            }
        });
    }

    /** Drops an event from a socket this link has already left. */
    private void post(int mine, Runnable event) {
        try {
            actor.execute(() -> {
                if (mine == epoch) event.run();
            });
        } catch (RejectedExecutionException e) {
            // Disposed: the socket's last callback lands after it.
        }
    }

    private void later(long delayMs, Runnable event) {
        int mine = epoch;
        actor.schedule(() -> {
            if (mine == epoch) event.run();
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private void onOpen() {
        connectedAt = clock.getAsLong();
        closingRetryAfter = -1;
        later(HELLO_WAIT_MS, () -> {
            if (session == null && handshake == null && !helloSeen) lost();
        });
        later(PING_EVERY_MS, this::ping);
        later(RESET_ATTEMPTS_AFTER_MS, () -> attempts = 0);
    }

    private void ping() {
        if (socket == null) return;
        socket.sendText("ping");
        pongPending = true;
        later(PONG_WAIT_MS, () -> {
            if (pongPending) lost();
        });
        later(PING_EVERY_MS, this::ping);
    }

    private void onText(String text) {
        if (text.equals("pong")) {
            pongPending = false;
            return;
        }
        JSONObject frame;
        try {
            frame = new JSONObject(text);
        } catch (JSONException e) {
            return;
        }
        switch (frame.optString("t")) {
            case "hello":
                onHello(frame);
                break;
            case "cezar-online":
                endSession();
                startHandshake();
                break;
            case "cezar-offline":
                endSession();
                setStatus(RelayStatus.of(RelayStatus.Kind.CEZAR_OFFLINE));
                break;
            case "closing":
                closingRetryAfter = frame.optLong("retryAfter", -1);
                break;
            default:
                // Unknown frames are ignored, so a later relay can add them (§ 4).
        }
    }

    private void onHello(JSONObject hello) {
        helloSeen = true;
        relayAnswered = true;
        proofRetried = false;
        if (hello.optInt("protocol", 1) != 1) {
            stopWith(RelayStatus.of(RelayStatus.Kind.UPDATE_APP));
            return;
        }
        JSONObject limits = hello.optJSONObject("limits");
        frameBytes = limits == null ? FRAME_DEFAULT : limits.optInt("frameBytes", FRAME_DEFAULT);
        if (frameBytes < FRAME_FLOOR) {
            stopWith(RelayStatus.of(RelayStatus.Kind.BROKEN));
            return;
        }
        // The key is absent on a 4430 hello, and `closing` follows (§ 4).
        String cezar = hello.optString("cezar");
        if (cezar.equals("online")) startHandshake();
        else if (cezar.equals("offline")) setStatus(RelayStatus.of(RelayStatus.Kind.CEZAR_OFFLINE));
    }

    private void stopWith(RelayStatus next) {
        running = false;
        dropSocket();
        setStatus(next);
    }

    private void startHandshake() {
        byte[] prologue = Bytes.concat(PROLOGUE_LABEL, Bytes.fromBase64url(target.cezarId), Bytes.fromBase64url(target.deviceId));
        handshake = NoiseHandshake.kkInitiator(prologue, target.keys.x25519Secret, target.cezarStatic);
        try {
            send(socket, handshake.writeMessage(new byte[0]));
        } catch (RelayCrypto.DecryptFailure | IOException e) {
            lost();
            return;
        }
        NoiseHandshake mine = handshake;
        later(KK_WAIT_MS, () -> {
            if (handshake == mine) onSilentHandshake();
        });
    }

    /** A relay that still admits a removed phone looks like this, so it must not stay invisible (§ 10.1). */
    private void onSilentHandshake() {
        silentHandshakes++;
        dropSocket();
        if (silentHandshakes >= SILENT_KK_LIMIT) setStatus(RelayStatus.of(RelayStatus.Kind.NOT_ANSWERING));
        reconnect(jitterMs());
    }

    private static void send(SocketTransport.Connection connection, byte[] ciphertext) throws IOException {
        if (!connection.sendBinary(Bytes.concat(new byte[] {1}, ciphertext))) throw new IOException("socket refused the frame");
    }

    private void onBinary(byte[] frame) {
        if (frame.length == 0 || frame[0] != 1) {
            lost();
            return;
        }
        byte[] ciphertext = java.util.Arrays.copyOfRange(frame, 1, frame.length);
        // A frame from an ended session can reach a new socket: the relay routes by deviceId (§ 10).
        if (handshake != null) {
            if ((ciphertext.length - TRANSPORT_OVERHEAD) % TunnelRecord.UNIT != 0) finishHandshake(ciphertext);
        }
        else if (session != null) session.receive(ciphertext);
    }

    private void finishHandshake(byte[] reply) {
        NoiseHandshake current = handshake.copy();
        byte[] payload;
        try {
            payload = current.readMessage(reply);
        } catch (RelayCrypto.DecryptFailure e) {
            lost();
            return;
        }
        handshake = null;
        silentHandshakes = 0;
        try {
            JSONObject json = new JSONObject(new String(TunnelRecord.unpad(payload), java.nio.charset.StandardCharsets.UTF_8));
            JSONObject tunnel = json.getJSONObject("tunnel");
            int cezarMin = tunnel.getInt("min");
            int cezarMax = tunnel.getInt("max");
            SocketTransport.Connection connection = socket;
            TunnelSession next = new TunnelSession(ciphertext -> send(connection, ciphertext), current.split(), frameBytes,
                    this::onSessionEnded, clock);
            if (Math.min(TunnelSession.TUNNEL_MAX, cezarMax) < Math.max(TunnelSession.TUNNEL_MIN, cezarMin)) {
                next.close(TunnelFrame.CLOSE_TUNNEL_UNSUPPORTED);
                stopWith(RelayStatus.of(TunnelSession.TUNNEL_MAX < cezarMin ? RelayStatus.Kind.UPDATE_APP : RelayStatus.Kind.UPDATE_CEZAR));
                return;
            }
            next.start();
            session = next;
            later(TunnelSession.LEASE_EVERY_MS, () -> leaseTick(next));
            setStatus(RelayStatus.of(RelayStatus.Kind.READY));
        } catch (TunnelRecord.Malformed | JSONException | IOException e) {
            lost();
        }
    }

    private void leaseTick(TunnelSession current) {
        if (session != current) return;
        try {
            if (current.leaseExpired()) {
                lost();
                return;
            }
            current.lease();
        } catch (IOException e) {
            lost();
            return;
        }
        later(TunnelSession.LEASE_EVERY_MS, () -> leaseTick(current));
    }

    /** On the actor, from {@link TunnelSession#receive}. `device-removed` waits for 4403, which the next connect gets. */
    private void onSessionEnded(int code) {
        session = null;
        lost();
    }

    private void endSession() {
        TunnelSession current = session;
        session = null;
        handshake = null;
        if (current != null) current.end();
    }

    private void dropSocket() {
        epoch++;
        endSession();
        helloSeen = false;
        pongPending = false;
        SocketTransport.Connection current = socket;
        socket = null;
        if (current != null) current.close(1000);
    }

    /** Network loss, and anything treated like it: close with 1000 and reconnect with jitter. */
    private void lost() {
        dropSocket();
        reconnect(jitterMs());
    }

    private long jitterMs() {
        long ceiling = 1000L << Math.min(attempts, 8);
        return 1000 + (long) (random.nextDouble() * (Math.min(300000, ceiling) - 1000 + 1));
    }

    private void reconnect(long delayMs) {
        if (!running) return;
        attempts++;
        RelayStatus.Kind now = status.kind;
        // A silent handshake is not the relay being down: it answered, cezar did not.
        boolean keep = now == RelayStatus.Kind.QUOTA || now == RelayStatus.Kind.CEZAR_OFFLINE || now == RelayStatus.Kind.NOT_ANSWERING
                || (now == RelayStatus.Kind.CONNECTING && silentHandshakes > 0);
        if (!keep) setStatus(RelayStatus.of(RelayStatus.Kind.RELAY_DOWN));
        later(delayMs, this::connect);
    }

    private void onClosed(int code) {
        epoch++;
        socket = null;
        endSession();
        helloSeen = false;
        pongPending = false;
        switch (code) {
            case 4400:
            case 4413:
                stopWith(RelayStatus.of(RelayStatus.Kind.BROKEN));
                break;
            case 4401:
                refusedProof(-1);
                break;
            case 4403:
                stopWith(RelayStatus.of(RelayStatus.Kind.DEVICE_REMOVED));
                break;
            case 4409:
                // Replaced by a newer socket: this one just ends.
                running = false;
                setStatus(RelayStatus.of(RelayStatus.Kind.IDLE));
                break;
            case 4426:
                stopWith(RelayStatus.of(RelayStatus.Kind.UPDATE_APP));
                break;
            case 4429:
                reconnect(closingRetryAfter > 0 ? closingRetryAfter * 1000 : jitterMs());
                break;
            case 4430:
                long seconds = closingRetryAfter > 0 ? closingRetryAfter : 300;
                setStatus(new RelayStatus(RelayStatus.Kind.QUOTA, seconds));
                reconnect(seconds * 1000);
                break;
            case 4503:
                reconnect(killSwitchMs());
                break;
            default:
                reconnect(jitterMs());
        }
    }

    private long killSwitchMs() {
        return 300000 + (long) (random.nextDouble() * 600000);
    }

    private void onRefused(int httpStatus, String code, long retryAfter, long date) {
        epoch++;
        socket = null;
        endSession();
        helloSeen = false;
        switch (httpStatus) {
            case 401:
                refusedProof(date);
                break;
            case 403:
                stopWith(RelayStatus.of(RelayStatus.Kind.DEVICE_REMOVED));
                break;
            case 426:
                stopWith(RelayStatus.of(RelayStatus.Kind.UPDATE_APP));
                break;
            case 429:
                reconnect(retryAfter > 0 ? retryAfter * 1000 : jitterMs());
                break;
            case 503:
                reconnect("relay-disabled".equals(code) ? killSwitchMs() : retryAfter > 0 ? retryAfter * 1000 : jitterMs());
                break;
            case 400:
            case 404:
            case 405:
            case 409:
                stopWith(RelayStatus.of(RelayStatus.Kind.BROKEN));
                break;
            default:
                reconnect(jitterMs());
        }
    }

    /** Retry once, correcting the time by `Date`, then stop and report (§ 3.2). */
    private void refusedProof(long date) {
        if (proofRetried) {
            stopWith(RelayStatus.of(RelayStatus.Kind.BROKEN));
            return;
        }
        proofRetried = true;
        if (date > 0) clockOffsetSeconds = (date - clock.getAsLong()) / 1000;
        connect();
    }
}
