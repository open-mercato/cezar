package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** One HTTP exchange inside a session (RELAY_PROTOCOL.md § 12): both windows, and the frames for its reader. */
public final class TunnelStream {
    public enum Kind { HEAD, DATA, END, RESET, LOST }

    /** What the reader gets next, in wire order. */
    public static final class Event {
        public final Kind kind;
        public final int status;
        public final List<TunnelFrame.Header> headers;
        public final byte[] data;
        public final int code;

        Event(Kind kind, int status, List<TunnelFrame.Header> headers, byte[] data, int code) {
            this.kind = kind;
            this.status = status;
            this.headers = headers;
            this.data = data;
            this.code = code;
        }
    }

    /** The request half cannot go on: the stream was reset or the session is gone. */
    public static final class Gone extends IOException {
        Gone() {
            super("stream gone");
        }
    }

    /** Near the § 12.2 limit of 131,072: each `WINDOW` counts against the relay's `framesPerSecond`. */
    private static final int CREDIT_EVERY = 120000;

    private final TunnelSession session;
    private final LinkedBlockingQueue<Event> events = new LinkedBlockingQueue<>();
    public final int id;
    private int sendWindow = TunnelFrame.MAX_WINDOW;
    private int receiveWindow = TunnelFrame.MAX_WINDOW;
    private int unacknowledged;
    private boolean localEnded;
    private boolean remoteEnded;
    private boolean headSeen;
    private boolean finished;

    TunnelStream(TunnelSession session, int id) {
        this.session = session;
        this.id = id;
    }

    /** Waits for window, and splits to the largest `DATA` payload. Forwards as it arrives (§ 12.2). */
    public void write(byte[] bytes, int offset, int length) throws IOException {
        int at = offset;
        int left = length;
        while (left > 0) {
            int chunk;
            synchronized (this) {
                while (sendWindow == 0 && !finished) waitForWindow();
                if (finished) throw new Gone();
                chunk = Math.min(Math.min(left, sendWindow), session.maxData());
                sendWindow -= chunk;
            }
            session.sendFrame(TunnelFrame.data(id, bytes, at, chunk));
            at += chunk;
            left -= chunk;
        }
    }

    private void waitForWindow() throws IOException {
        try {
            wait(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Gone();
        }
    }

    /** The request is complete. */
    public void finishRequest() throws IOException {
        synchronized (this) {
            if (finished || localEnded) return;
            localEnded = true;
        }
        session.sendFrame(TunnelFrame.end(id));
        maybeFinished();
    }

    /** The next event, or null after `timeoutMs`. */
    public Event next(long timeoutMs) throws InterruptedException {
        return events.poll(timeoutMs, TimeUnit.MILLISECONDS);
    }

    /** Credit for bytes the consumer really took, so a stalled page stalls the sender (§ 12.2). */
    public void consumed(int bytes) {
        int credit = 0;
        synchronized (this) {
            if (finished || remoteEnded) return;
            unacknowledged += bytes;
            if (unacknowledged >= CREDIT_EVERY) {
                credit = unacknowledged;
                unacknowledged = 0;
                receiveWindow += credit;
            }
        }
        if (credit > 0) sendQuietly(TunnelFrame.window(id, credit));
    }

    /** The reader went away. */
    public void cancel(int code) {
        synchronized (this) {
            if (finished) return;
            finish();
        }
        session.forget(this);
        sendQuietly(TunnelFrame.reset(id, code));
    }

    private void sendQuietly(byte[] frame) {
        try {
            session.sendFrame(frame);
        } catch (IOException e) {
            // The session's own end reaches every stream.
        }
    }

    private synchronized void finish() {
        finished = true;
        notifyAll();
    }

    private void maybeFinished() {
        boolean done;
        synchronized (this) {
            done = !finished && localEnded && remoteEnded;
            if (done) finish();
        }
        if (done) session.forget(this);
    }

    void onHead(TunnelFrame frame) throws TunnelRecord.Malformed {
        synchronized (this) {
            if (headSeen || remoteEnded) throw new TunnelRecord.Malformed("second HEAD");
            headSeen = true;
        }
        events.add(new Event(Kind.HEAD, frame.status, frame.headers, null, 0));
    }

    void onData(TunnelFrame frame) throws TunnelRecord.Malformed {
        boolean over;
        synchronized (this) {
            if (!headSeen || remoteEnded) throw new TunnelRecord.Malformed("DATA out of order");
            if (frame.data.length == 0) return;
            over = frame.data.length > receiveWindow;
            if (!over) receiveWindow -= frame.data.length;
        }
        if (over) {
            events.add(new Event(Kind.RESET, 0, null, null, TunnelFrame.RESET_FLOW_CONTROL));
            cancel(TunnelFrame.RESET_FLOW_CONTROL);
            return;
        }
        events.add(new Event(Kind.DATA, 0, null, frame.data, 0));
    }

    void onEnd() throws TunnelRecord.Malformed {
        synchronized (this) {
            if (!headSeen || remoteEnded) throw new TunnelRecord.Malformed("END out of order");
            remoteEnded = true;
        }
        events.add(new Event(Kind.END, 0, null, null, 0));
        maybeFinished();
    }

    void onReset(int code) {
        synchronized (this) {
            if (finished) return;
            finish();
        }
        session.forget(this);
        events.add(new Event(Kind.RESET, 0, null, null, code));
    }

    void onWindow(int increment) {
        boolean over;
        synchronized (this) {
            over = sendWindow + (long) increment > TunnelFrame.MAX_WINDOW;
            if (!over) {
                sendWindow += increment;
                notifyAll();
            }
        }
        if (over) {
            events.add(new Event(Kind.RESET, 0, null, null, TunnelFrame.RESET_FLOW_CONTROL));
            cancel(TunnelFrame.RESET_FLOW_CONTROL);
        }
    }

    void onLost() {
        finish();
        events.add(new Event(Kind.LOST, 0, null, null, 0));
    }
}
