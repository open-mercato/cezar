package com.openmercato.cezar.mobile.shell.push;

import java.io.IOException;
import java.util.Random;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;
import java.util.logging.Logger;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Stage 1 push: `GET /workspace/phone/signals` held open inside a live session while the server's
 * switch is on (spec R5 as built). Reopened with backoff while the session lasts; a 404 or 409
 * stops it for this view's life. Logs statuses only.
 */
public final class SignalStream {
    private static final Logger LOG = Logger.getLogger("cezar.push");
    public static final String PATH = "/api/v1/workspace/phone/signals";
    /** cezar pings every 30 s: three missed pings and the stream is dead, whatever the session says. */
    static final long SILENCE_MS = 95_000;
    static final long MAX_BACKOFF_MS = 60_000;

    /** Opens the stream in the current session; throws when there is none. */
    public interface Source {
        Connection open() throws IOException;
    }

    public interface Connection {
        int status();

        /** The next bytes, null after `timeoutMs`; throws once the stream has ended. */
        byte[] read(long timeoutMs) throws IOException;

        void close();
    }

    public interface Listener {
        /** `managerId` is null, or passed {@link PushTap#validManagerId}. */
        void signal(String managerId);
    }

    public interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    public enum End { STOPPED, REFUSED, NO_SESSION }

    enum Next { READ, STOP, RETRY }

    private final Source source;
    private final BooleanSupplier wanted;
    private final Listener listener;
    private final Random random;
    private final Object wake = new Object();
    private final Sleeper sleeper;
    private volatile boolean stopped;
    private volatile Connection current;
    private boolean running;
    private boolean refused;

    /** `wanted`: the session is up, the switch is on and notifications are allowed. Asked before each open. */
    public SignalStream(Source source, BooleanSupplier wanted, Listener listener, Random random) {
        this(source, wanted, listener, random, null);
    }

    SignalStream(Source source, BooleanSupplier wanted, Listener listener, Random random, Sleeper sleeper) {
        this.source = source;
        this.wanted = wanted;
        this.listener = listener;
        this.random = random;
        this.sleeper = sleeper != null ? sleeper : this::await;
    }

    /** 404: an unknown device or a cezar without the route. 409: cezar has `CEZ_PUSH=0`. Neither changes by asking again. */
    static Next decide(int status) {
        if (status == 200) return Next.READ;
        if (status == 404 || status == 409) return Next.STOP;
        return Next.RETRY;
    }

    /** Full jitter: 1 s to min(60 s, 2^n s). */
    long backoffMs(int attempts) {
        long cap = Math.min(MAX_BACKOFF_MS, 1000L << Math.min(attempts + 1, 20));
        return 1000 + (long) (random.nextDouble() * (cap - 1000));
    }

    /** The session came up or the switch went on. A no-op while one runs, after a refusal, or once stopped. */
    public synchronized void ensureRunning(Executor executor) {
        if (running || refused || stopped) return;
        running = true;
        executor.execute(() -> {
            End end = End.STOPPED;
            try {
                end = run();
            } finally {
                synchronized (this) {
                    if (end != End.NO_SESSION) running = false;
                    if (end == End.REFUSED) refused = true;
                }
            }
        });
    }

    /** For good: the view is gone. */
    public void stop() {
        stopped = true;
        Connection open = current;
        if (open != null) open.close();
        synchronized (wake) {
            wake.notifyAll();
        }
    }

    /** Blocks until stopped, refused, or no longer wanted. NO_SESSION has cleared `running` already. */
    End run() {
        int attempts = 0;
        while (true) {
            if (stopped) return End.STOPPED;
            if (!stillWanted()) return End.NO_SESSION;
            switch (once()) {
                case STOP:
                    return End.REFUSED;
                case READ:
                    attempts = 0;
                    break;
                default:
                    break;
            }
            if (stopped) return End.STOPPED;
            if (!stillWanted()) return End.NO_SESSION;
            try {
                sleeper.sleep(backoffMs(attempts++));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return End.STOPPED;
            }
        }
    }

    /** One step with {@link #ensureRunning}, so a session that comes back during this exit is not missed. */
    private synchronized boolean stillWanted() {
        if (wanted.getAsBoolean()) return true;
        running = false;
        return false;
    }

    /** READ when `ready` arrived before the stream ended, which resets the backoff. */
    private Next once() {
        Connection connection;
        try {
            connection = source.open();
        } catch (IOException e) {
            return Next.RETRY;
        }
        current = connection;
        boolean[] ready = {false};
        try {
            Next next = decide(connection.status());
            if (next != Next.READ) {
                LOG.info("push signals: " + connection.status());
                return next;
            }
            SignalParser parser = new SignalParser((type, data) -> {
                if ("ready".equals(type)) ready[0] = true;
                else if ("signal".equals(type)) onSignal(data);
            });
            while (!stopped) {
                byte[] bytes = connection.read(SILENCE_MS);
                if (bytes == null) break;
                parser.feed(bytes, 0, bytes.length);
            }
        } catch (IOException e) {
            // Ended: the session went, or cezar closed it.
        } finally {
            current = null;
            connection.close();
        }
        return ready[0] ? Next.READ : Next.RETRY;
    }

    /** `{ managerId? }`. Anything that is not a JSON object is dropped, not shown. */
    private void onSignal(String data) {
        JSONObject body;
        try {
            body = new JSONObject(data);
        } catch (JSONException e) {
            return;
        }
        Object value = body.opt("managerId");
        String managerId = value instanceof String && PushTap.validManagerId((String) value) ? (String) value : null;
        try {
            listener.signal(managerId);
        } catch (RuntimeException e) {
            LOG.info("push signal: not shown");
        }
    }

    private void await(long ms) throws InterruptedException {
        synchronized (wake) {
            if (!stopped) wake.wait(ms);
        }
    }
}
