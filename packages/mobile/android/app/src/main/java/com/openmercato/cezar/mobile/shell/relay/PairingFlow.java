package com.openmercato.cezar.mobile.shell.relay;

import java.util.function.Consumer;

/** One pairing at a time, for a connect page that polls. A snapshot sequence number stands in for events. */
public final class PairingFlow {
    /** What the page reads. */
    public static final class Snapshot {
        public final int seq;
        public final PairingClient.Phase phase;
        public final String digits;
        public final String label;
        public final String reason;

        Snapshot(int seq, PairingClient.Phase phase, String digits, String label, String reason) {
            this.seq = seq;
            this.phase = phase;
            this.digits = digits;
            this.label = label;
            this.reason = reason;
        }
    }

    /** Called once with what approval gave; returns when the server is saved. */
    public interface Saver {
        void save(RelayOrigin relay, PairingClient.State state, DeviceKeys keys);
    }

    private final SocketTransport transport;
    private final String phoneName;
    private final boolean debugBuild;
    private final Saver saver;
    private PairingClient client;
    private int seq;
    private Snapshot latest = new Snapshot(0, PairingClient.Phase.FAILED, null, null, "cancelled");

    public PairingFlow(SocketTransport transport, String phoneName, boolean debugBuild, Saver saver) {
        this.transport = transport;
        this.phoneName = phoneName;
        this.debugBuild = debugBuild;
        this.saver = saver;
    }

    public Snapshot startQr(String text) {
        try {
            return start(PairSecret.fromQr(text == null ? "" : text.trim(), debugBuild));
        } catch (RelayOrigin.Refused refused) {
            return refused(refused.reason.equals("version") ? "update-app" : refused.reason.equals("cleartext") ? "qr-cleartext" : "qr-invalid");
        }
    }

    /** Runs PBKDF2, so never on the main thread. */
    public Snapshot startCode(String code, String relayAddress) {
        RelayOrigin relay;
        try {
            relay = RelayOrigin.parseTyped(relayAddress, debugBuild);
        } catch (RelayOrigin.Refused refused) {
            return refused(refused.reason.equals("cleartext") ? "relay-cleartext" : "relay-invalid");
        }
        try {
            return start(PairSecret.fromCode(code, relay));
        } catch (RelayOrigin.Refused refused) {
            return refused("code-invalid");
        }
    }

    private synchronized Snapshot refused(String reason) {
        return publish(PairingClient.Phase.FAILED, null, null, reason);
    }

    private synchronized Snapshot start(PairSecret secret) {
        if (client != null) client.cancel();
        DeviceKeys keys = DeviceKeys.generate();
        Consumer<PairingClient.State> onState = state -> update(secret, keys, state);
        PairingClient next = new PairingClient(transport, secret, keys, phoneName, onState::accept);
        client = next;
        Snapshot snapshot = publish(PairingClient.Phase.CONNECTING, null, null, null);
        next.start();
        return snapshot;
    }

    private void update(PairSecret secret, DeviceKeys keys, PairingClient.State state) {
        // Saved before the page hears of it, so a poll that reads APPROVED finds the server.
        if (state.phase == PairingClient.Phase.APPROVED) saver.save(secret.relay, state, keys);
        synchronized (this) {
            publish(state.phase, state.digits, state.label, state.reason);
        }
    }

    private Snapshot publish(PairingClient.Phase phase, String digits, String label, String reason) {
        latest = new Snapshot(++seq, phase, digits, label, reason);
        notifyAll();
        return latest;
    }

    public synchronized void cancel() {
        if (client != null) client.cancel();
    }

    /** Returns when the sequence moves past `seen`, or after `timeoutMs` with the same snapshot. */
    public synchronized Snapshot next(int seen, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (latest.seq <= seen) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) break;
            wait(left);
        }
        return latest;
    }
}
