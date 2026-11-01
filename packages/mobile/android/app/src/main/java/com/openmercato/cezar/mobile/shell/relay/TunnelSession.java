package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/** The phone's half of one tunnel (RELAY_PROTOCOL.md § 12) over one `KK` session. Never outlives its socket. */
public final class TunnelSession {
    public interface Wire {
        /** One Noise transport message; the frame byte is the wire's business. */
        void send(byte[] ciphertext) throws IOException;
    }

    public interface Listener {
        /** A `CLOSE` arrived: `code` is its code. Or a protocol error: `code` is CLOSE_PROTOCOL_ERROR. */
        void ended(int code);
    }

    public static final class TooManyStreams extends IOException {
        TooManyStreams() {
            super("too many streams");
        }
    }

    public static final class HeadTooLarge extends IOException {
        HeadTooLarge() {
            super("head too large");
        }
    }

    public static final int TUNNEL_MIN = 1;
    public static final int TUNNEL_MAX = 1;
    public static final int MAX_STREAMS = 32;
    public static final long LEASE_EVERY_MS = 20000;
    public static final long LEASE_DEADLINE_MS = 45000;
    private static final long REKEY_AFTER_MS = 3600000;
    private static final long REKEY_AFTER_MESSAGES = 1L << 32;

    private final Wire wire;
    private final NoiseCipher send;
    private final NoiseCipher receive;
    private final int maxData;
    private final Listener listener;
    private final LongSupplier clock;
    private final ConcurrentHashMap<Integer, TunnelStream> streams = new ConcurrentHashMap<>();
    private long highest;
    private long keyedAt;
    private long keyedNonce;
    private volatile long leaseAt;
    private volatile boolean ended;

    public TunnelSession(Wire wire, NoiseHandshake.Keys keys, int frameBytes, Listener listener, LongSupplier clock) {
        this.wire = wire;
        this.send = keys.send;
        this.receive = keys.receive;
        this.maxData = TunnelRecord.maxData(frameBytes);
        this.listener = listener;
        this.clock = clock;
        this.keyedAt = clock.getAsLong();
        this.leaseAt = keyedAt;
    }

    /** `HELLO`, then `LEASE`, the required opening (§ 12.1). */
    public void start() throws IOException {
        sendFrame(TunnelFrame.hello(TUNNEL_MIN, TUNNEL_MAX));
        sendFrame(TunnelFrame.lease());
    }

    public int maxData() {
        return maxData;
    }

    public boolean live() {
        return !ended;
    }

    public void lease() throws IOException {
        sendFrame(TunnelFrame.lease());
    }

    /** True once cezar has been silent past the 45 s rule (§ 12.3). */
    public boolean leaseExpired() {
        return clock.getAsLong() - leaseAt >= LEASE_DEADLINE_MS;
    }

    /** Sends one frame, under the key the rekey rule says. */
    void sendFrame(byte[] content) throws IOException {
        try {
            encryptAndSend(content);
        } catch (IOException e) {
            // The nonce moved and the frame did not: nothing later could be decrypted.
            end();
            throw e;
        }
    }

    /** The lock keeps nonce order equal to wire order. */
    private synchronized void encryptAndSend(byte[] content) throws IOException {
        if (ended) throw new IOException("session ended");
        rekeyIfDue();
        wire.send(send.encrypt(TunnelRecord.pad(content)));
    }

    private void rekeyIfDue() throws IOException {
        boolean due = clock.getAsLong() - keyedAt >= REKEY_AFTER_MS || send.nonce() - keyedNonce >= REKEY_AFTER_MESSAGES;
        if (!due) return;
        wire.send(send.encrypt(TunnelRecord.pad(TunnelFrame.rekey())));
        send.rekey();
        keyedAt = clock.getAsLong();
        keyedNonce = send.nonce();
    }

    /** Opens a stream. Nothing is sent when the head does not fit or the session is full. */
    public synchronized TunnelStream open(String method, String target, List<TunnelFrame.Header> headers) throws IOException {
        if (ended) throw new IOException("session ended");
        if (streams.size() >= MAX_STREAMS) throw new TooManyStreams();
        if (highest >= 0xffffffffL) throw new IOException("stream ids exhausted");
        int id = (int) (highest + 1);
        byte[] frame = TunnelFrame.open(id, method, target, headers);
        if (frame.length > TunnelFrame.MAX_HEAD_BYTES) throw new HeadTooLarge();
        highest++;
        TunnelStream stream = new TunnelStream(this, id);
        streams.put(id, stream);
        sendFrame(frame);
        return stream;
    }

    void forget(TunnelStream stream) {
        streams.remove(stream.id);
    }

    /** One Noise transport message from cezar. Any failure ends the session (§ 10.1). */
    public void receive(byte[] ciphertext) {
        if (ended) return;
        try {
            handle(TunnelFrame.parse(TunnelRecord.unpad(receive.decrypt(ciphertext))));
        } catch (RelayCrypto.DecryptFailure | TunnelRecord.Malformed e) {
            fail(TunnelFrame.CLOSE_PROTOCOL_ERROR);
        }
    }

    private void handle(TunnelFrame frame) throws TunnelRecord.Malformed {
        switch (frame.type) {
            case TunnelFrame.LEASE:
                leaseAt = clock.getAsLong();
                return;
            case TunnelFrame.REKEY:
                receive.rekey();
                return;
            case TunnelFrame.CLOSE:
                closed(frame.code >= TunnelFrame.CLOSE_NORMAL && frame.code <= TunnelFrame.CLOSE_DEVICE_REMOVED ? frame.code : TunnelFrame.CLOSE_PROTOCOL_ERROR);
                return;
            case TunnelFrame.HEAD:
            case TunnelFrame.DATA:
            case TunnelFrame.END:
            case TunnelFrame.RESET:
            case TunnelFrame.WINDOW:
                break;
            default:
                throw new TunnelRecord.Malformed("a frame this direction may not send");
        }
        long id = frame.stream & 0xffffffffL;
        synchronized (this) {
            if (id > highest) throw new TunnelRecord.Malformed("a stream that was never opened");
        }
        TunnelStream stream = streams.get(frame.stream);
        // Finished or reset already: it crossed in flight (§ 12.1).
        if (stream == null) return;
        switch (frame.type) {
            case TunnelFrame.HEAD:
                stream.onHead(frame);
                break;
            case TunnelFrame.DATA:
                stream.onData(frame);
                break;
            case TunnelFrame.END:
                stream.onEnd();
                break;
            case TunnelFrame.RESET:
                stream.onReset(frame.code);
                break;
            default:
                stream.onWindow(frame.increment);
        }
    }

    private void fail(int code) {
        try {
            sendFrame(TunnelFrame.close(code));
        } catch (IOException | RuntimeException e) {
            // "If it can."
        }
        closed(code);
    }

    private void closed(int code) {
        end();
        listener.ended(code);
    }

    /** Sends `CLOSE` as the last frame, best effort. */
    public void close(int code) {
        try {
            sendFrame(TunnelFrame.close(code));
        } catch (IOException e) {
            // The socket is going anyway.
        }
        end();
    }

    /** Ends every stream, which is a 502 or an abort at the proxy (§ 10.1). */
    public void end() {
        List<TunnelStream> open;
        synchronized (this) {
            if (ended) return;
            ended = true;
            open = new ArrayList<>(streams.values());
            streams.clear();
        }
        for (TunnelStream stream : open) stream.onLost();
    }
}
