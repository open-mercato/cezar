package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/** The phone's side of one rendezvous (RELAY_PROTOCOL.md §§ 5, 9). One thread, and never reconnected. */
public final class PairingClient {
    public enum Phase { CONNECTING, CONFIRM, APPROVED, FAILED }

    /** A snapshot for the connect page. `reason` is set on FAILED; see screens.js. */
    public static final class State {
        public final Phase phase;
        public final String digits;
        public final String label;
        public final String reason;
        public final String cezarId;
        public final byte[] cezarStatic;

        State(Phase phase, String digits, String label, String reason, String cezarId, byte[] cezarStatic) {
            this.phase = phase;
            this.digits = digits;
            this.label = label;
            this.reason = reason;
            this.cezarId = cezarId;
            this.cezarStatic = cezarStatic;
        }
    }

    public interface Updates {
        void state(State state);
    }

    private static final long XX_DEADLINE_MS = 30000;
    private static final long PING_EVERY_MS = 45000;
    private static final int MAX_NAME_BYTES = 64;
    private static final int MAX_MESSAGE_BYTES = 1024;
    private static final byte[] PROLOGUE_LABEL = Bytes.ascii("cezar-pair-v1");

    private final SocketTransport transport;
    private final PairSecret secret;
    private final DeviceKeys keys;
    private final String name;
    private final Updates updates;
    private final ScheduledExecutorService actor = Executors.newSingleThreadScheduledExecutor(run -> {
        Thread thread = new Thread(run, "cezar-relay-pair");
        thread.setDaemon(true);
        return thread;
    });
    private SocketTransport.Connection socket;
    private NoiseHandshake handshake;
    private NoiseHandshake.Keys transportKeys;
    private String digits;
    private String label;
    private String cezarId;
    private byte[] cezarStatic;
    private boolean hello;
    private boolean finished;

    public PairingClient(SocketTransport transport, PairSecret secret, DeviceKeys keys, String phoneName, Updates updates) {
        this.transport = transport;
        this.secret = secret;
        this.keys = keys;
        this.name = safeName(phoneName);
        this.updates = updates;
    }

    /** No control characters, and cut on a character boundary at 64 UTF-8 bytes (§ 9.3). */
    public static String safeName(String raw) {
        StringBuilder out = new StringBuilder();
        int bytes = 0;
        String text = raw == null ? "" : raw;
        for (int i = 0; i < text.length(); ) {
            int point = text.codePointAt(i);
            i += Character.charCount(point);
            if (Character.isISOControl(point)) continue;
            String one = new String(Character.toChars(point));
            int size = Bytes.utf8(one).length;
            if (bytes + size > MAX_NAME_BYTES) break;
            bytes += size;
            out.append(one);
        }
        return out.length() == 0 ? "Android phone" : out.toString();
    }

    public void start() {
        actor.execute(() -> {
            updates.state(state(Phase.CONNECTING, null));
            String url = secret.relay.socketOrigin + "/v1/pair/" + secret.locator() + "?role=phone";
            socket = transport.connect(url, Collections.<String, String>emptyMap(), new SocketTransport.Events() {
                @Override
                public void opened() {
                    // Nothing is sent until hello and peer-joined.
                }

                @Override
                public void text(String text) {
                    post(() -> onText(text));
                }

                @Override
                public void binary(byte[] bytes) {
                    post(() -> onBinary(bytes));
                }

                @Override
                public void closed(int code) {
                    post(() -> onClosed(code));
                }

                @Override
                public void failed(int status, String code, long retryAfter, long date) {
                    post(() -> onRefused(status));
                }
            });
            actor.schedule(this::ping, PING_EVERY_MS, TimeUnit.MILLISECONDS);
        });
    }

    public void cancel() {
        post(() -> finish(Phase.FAILED, "cancelled"));
    }

    /** The socket's last callback lands after {@link #finish}, when the actor is already gone. */
    private void post(Runnable event) {
        try {
            actor.execute(() -> {
                if (!finished) event.run();
            });
        } catch (RejectedExecutionException e) {
            // Finished.
        }
    }

    private void ping() {
        if (finished || socket == null) return;
        socket.sendText("ping");
        actor.schedule(this::ping, PING_EVERY_MS, TimeUnit.MILLISECONDS);
    }

    private State state(Phase phase, String reason) {
        return new State(phase, digits, label, reason, cezarId, cezarStatic);
    }

    private void finish(Phase phase, String reason) {
        if (finished) return;
        finished = true;
        if (socket != null) socket.close(1000);
        try {
            updates.state(state(phase, reason));
        } finally {
            actor.shutdown();
        }
    }

    private void onText(String text) {
        JSONObject frame;
        try {
            frame = new JSONObject(text);
        } catch (JSONException e) {
            return;
        }
        switch (frame.optString("t")) {
            case "hello":
                hello = true;
                if (frame.optInt("protocol", 1) != 1) finish(Phase.FAILED, "update-app");
                break;
            case "peer-joined":
                onPeerJoined();
                break;
            case "peer-left":
                finish(Phase.FAILED, "lost");
                break;
            default:
                // Readers ignore what they do not know (§ 4).
        }
    }

    private void onPeerJoined() {
        if (!hello || handshake != null) return;
        byte[] prologue = Bytes.concat(PROLOGUE_LABEL, secret.locatorBytes);
        handshake = NoiseHandshake.xxpsk3Initiator(prologue, keys.x25519Secret, secret.psk);
        try {
            sendData(handshake.writeMessage(new byte[0]));
        } catch (RelayCrypto.DecryptFailure | IOException e) {
            finish(Phase.FAILED, "lost");
            return;
        }
        actor.schedule(() -> post(() -> {
            if (transportKeys == null) finish(Phase.FAILED, "timeout");
        }), XX_DEADLINE_MS, TimeUnit.MILLISECONDS);
    }

    private void sendData(byte[] ciphertext) throws IOException {
        if (!socket.sendBinary(Bytes.concat(new byte[] {1}, ciphertext))) throw new IOException("socket refused the frame");
    }

    private void onBinary(byte[] frame) {
        if (frame.length == 0 || frame[0] != 1 || handshake == null) {
            finish(Phase.FAILED, "lost");
            return;
        }
        byte[] ciphertext = Arrays.copyOfRange(frame, 1, frame.length);
        try {
            if (transportKeys == null) onSecondMessage(ciphertext);
            else onMessage(new String(TunnelRecord.unpad(transportKeys.receive.decrypt(ciphertext)), StandardCharsets.UTF_8));
        } catch (RelayCrypto.DecryptFailure | TunnelRecord.Malformed | JSONException | IOException e) {
            finish(Phase.FAILED, "internal");
        }
    }

    private void onSecondMessage(byte[] message) throws RelayCrypto.DecryptFailure, JSONException, IOException {
        byte[] payload;
        try {
            payload = handshake.readMessage(message);
        } catch (RelayCrypto.DecryptFailure e) {
            // Wrong PSK or a peer that only knows the locator.
            finish(Phase.FAILED, "pin-mismatch");
            return;
        }
        if (payload.length != 0) {
            finish(Phase.FAILED, "internal");
            return;
        }
        if (secret.pinnedKey != null && !org.bouncycastle.util.Arrays.constantTimeAreEqual(secret.pinnedKey, handshake.remoteStatic())) {
            finish(Phase.FAILED, "pin-mismatch");
            return;
        }
        JSONObject tunnel = new JSONObject().put("min", TunnelSession.TUNNEL_MIN).put("max", TunnelSession.TUNNEL_MAX);
        JSONObject phone = new JSONObject().put("name", name).put("platform", "android")
                .put("relayKey", Bytes.base64url(keys.relayKey())).put("tunnel", tunnel);
        sendData(handshake.writeMessage(TunnelRecord.pad(Bytes.utf8(phone.toString()))));
        transportKeys = handshake.split();
        digits = PairSecret.sasDigits(handshake.handshakeHash());
        cezarStatic = handshake.remoteStatic();
    }

    private void onMessage(String text) throws JSONException {
        if (Bytes.utf8(text).length > MAX_MESSAGE_BYTES) {
            finish(Phase.FAILED, "internal");
            return;
        }
        JSONObject message = new JSONObject(text);
        switch (message.optString("t")) {
            case "pending":
                onPending(message);
                break;
            case "approved":
                if (cezarId == null) finish(Phase.FAILED, "internal");
                else finish(Phase.APPROVED, null);
                break;
            case "denied":
                finish(Phase.FAILED, "denied");
                break;
            case "failure":
                onFailure(message);
                break;
            default:
                // A later cezar may say more.
        }
    }

    private void onPending(JSONObject message) throws JSONException {
        // The six digits on screen were shown for this cezar.
        if (cezarId != null) return;
        byte[] relayKey = Bytes.fromBase64url(message.optString("relayKey"), 32);
        String named = message.optString("label");
        JSONObject tunnel = message.getJSONObject("tunnel");
        if (relayKey == null || named.isEmpty()) {
            finish(Phase.FAILED, "internal");
            return;
        }
        int problem = tunnelProblem(tunnel);
        if (problem != 0) {
            finish(Phase.FAILED, problem < 0 ? "update-app" : "update-cezar");
            return;
        }
        cezarId = RelayIds.id(relayKey);
        label = safeName(named);
        updates.state(state(Phase.CONFIRM, null));
    }

    /** Negative: this app is too old. Positive: cezar is. Zero: a shared version exists. */
    private static int tunnelProblem(JSONObject tunnel) throws JSONException {
        int min = tunnel.getInt("min");
        int max = tunnel.getInt("max");
        if (Math.min(TunnelSession.TUNNEL_MAX, max) >= Math.max(TunnelSession.TUNNEL_MIN, min)) return 0;
        return TunnelSession.TUNNEL_MAX < min ? -1 : 1;
    }

    private void onFailure(JSONObject message) throws JSONException {
        String reason = message.optString("reason");
        if (reason.equals("tunnel-unsupported") && message.has("tunnel")) {
            finish(Phase.FAILED, tunnelProblem(message.getJSONObject("tunnel")) < 0 ? "update-app" : "update-cezar");
            return;
        }
        boolean known = Arrays.asList("device-limit", "relay-error", "timeout", "cancelled", "contested", "bad-payload").contains(reason);
        finish(Phase.FAILED, known ? reason : "internal");
    }

    private void onClosed(int code) {
        switch (code) {
            case 4404:
                finish(Phase.FAILED, "not-found");
                break;
            case 4408:
                finish(Phase.FAILED, "expired");
                break;
            case 4410:
                finish(Phase.FAILED, "taken");
                break;
            case 4426:
                finish(Phase.FAILED, "update-app");
                break;
            case 4429:
                finish(Phase.FAILED, "rate-limited");
                break;
            case 4503:
                finish(Phase.FAILED, "relay-disabled");
                break;
            default:
                finish(Phase.FAILED, "lost");
        }
    }

    private void onRefused(int status) {
        switch (status) {
            case 0:
                finish(Phase.FAILED, "relay-unreachable");
                break;
            case 404:
                finish(Phase.FAILED, "not-found");
                break;
            case 409:
                finish(Phase.FAILED, "taken");
                break;
            case 426:
                finish(Phase.FAILED, "update-app");
                break;
            case 429:
                finish(Phase.FAILED, "rate-limited");
                break;
            case 503:
                finish(Phase.FAILED, "relay-disabled");
                break;
            default:
                finish(Phase.FAILED, "internal");
        }
    }
}
