package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.RelayLink;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * One round of probes over the saved servers, for the switcher sheet and the Your cezars list alike: each
 * bounded, each warming the link a switch will take, and a cezar's answer noted in the book with its counts.
 * Reports arrive through the listener, from any thread.
 */
public final class DeviceProbes {
    public static final long BOUND_MS = DeviceSwitch.PROBE_MS;

    /** One probe's answer. `kind` is the RelayStatus or HealthAnswer kind; null while checking, or offline at the bound. */
    public static final class Reading {
        public final DeviceSwitch.Status status;
        public final String kind;

        Reading(DeviceSwitch.Status status, String kind) {
            this.status = status;
            this.kind = kind;
        }

        public static final Reading CHECKING = new Reading(DeviceSwitch.Status.CHECKING, null);
        public static final Reading OFFLINE = new Reading(DeviceSwitch.Status.OFFLINE, null);

        /** Connecting, or not started, is no answer yet. */
        public static Reading of(RelayStatus.Kind kind) {
            return DeviceSwitch.answered(kind) ? new Reading(DeviceSwitch.of(kind), kind.name()) : CHECKING;
        }

        public static Reading of(HealthAnswer.Kind kind) {
            return new Reading(DeviceSwitch.of(kind), kind.name());
        }

        boolean same(Reading other) {
            return status == other.status && (kind == null ? other.kind == null : kind.equals(other.kind));
        }
    }

    /** What a probe tells: readings (more than one as a link's status moves on), a cezar's health, and when it is done. */
    public interface Report {
        void reading(Reading reading);

        void health(HealthAnswer answer);

        void done();
    }

    /** Starts a probe; must not block. */
    public interface Probe {
        void start(ServerRecord server, Report report);
    }

    public interface Scheduler {
        void after(long ms, Runnable work);
    }

    public interface Listener {
        void changed(String id, Reading reading);
    }

    /** The phone's record of each server: an answer from cezar is a sighting with counts. */
    public interface Book {
        void saw(String id, HealthAnswer answer);
    }

    private final Probe relay;
    private final Probe direct;
    private final Consumer<String> release;
    private final Scheduler schedule;
    private final Book book;
    private final Listener onChange;
    private final Map<String, Reading> readings = new HashMap<>();
    private final Set<String> waiting = new HashSet<>();
    private final List<Runnable> onSettled = new ArrayList<>();
    private boolean settled;
    private boolean stopped;

    /** `release(keep)` lets go of the warm links but `keep`'s (null for none), as the probing ends. */
    public DeviceProbes(Probe relay, Probe direct, Consumer<String> release, Scheduler schedule, Book book, Listener onChange) {
        this.relay = relay;
        this.direct = direct;
        this.release = release;
        this.schedule = schedule;
        this.book = book;
        this.onChange = onChange;
    }

    public void start(List<ServerRecord> servers) {
        synchronized (this) {
            for (ServerRecord server : servers) {
                readings.put(server.id, Reading.CHECKING);
                waiting.add(server.id);
            }
        }
        for (ServerRecord server : servers) {
            String id = server.id;
            (server.relay != null ? relay : direct).start(server, new Report() {
                @Override
                public void reading(Reading reading) {
                    update(id, reading, false);
                }

                @Override
                public void health(HealthAnswer answer) {
                    if (answer == null || answer.kind != HealthAnswer.Kind.CEZAR || book == null) return;
                    book.saw(id, answer);
                    // The same reading, with fresh counts in the book.
                    Reading now;
                    synchronized (DeviceProbes.this) {
                        now = stopped ? null : readings.get(id);
                    }
                    if (now != null) onChange.changed(id, now);
                }

                @Override
                public void done() {
                    finished(id);
                }
            });
        }
        // Not known by the bound reads offline; a later report still turns the row.
        schedule.after(BOUND_MS, () -> {
            for (ServerRecord server : servers) update(server.id, Reading.OFFLINE, true);
            settle();
        });
        if (servers.isEmpty()) settle();
    }

    public synchronized Map<String, Reading> snapshot() {
        return new HashMap<>(readings);
    }

    /** Runs once, when every probe is done or at the bound; at once if that has passed. */
    public void whenSettled(Runnable then) {
        synchronized (this) {
            if (!settled) {
                onSettled.add(then);
                return;
            }
        }
        then.run();
    }

    /** The probing ended. `keep` is a switch's target: its link is about to be the current one. */
    public void stop(String keep) {
        synchronized (this) {
            if (stopped) return;
            stopped = true;
        }
        release.accept(keep);
    }

    private void update(String id, Reading next, boolean timedOut) {
        synchronized (this) {
            Reading before = readings.get(id);
            if (before == null || stopped || before.same(next)) return;
            if (timedOut && before.status != DeviceSwitch.Status.CHECKING) return;
            // A link still connecting after the bound stays offline until it says otherwise.
            if (next.status == DeviceSwitch.Status.CHECKING && before.status != DeviceSwitch.Status.CHECKING) return;
            readings.put(id, next);
        }
        onChange.changed(id, next);
    }

    private void finished(String id) {
        boolean all;
        synchronized (this) {
            all = waiting.remove(id) && waiting.isEmpty();
        }
        if (all) settle();
    }

    private void settle() {
        List<Runnable> then;
        synchronized (this) {
            if (settled) return;
            settled = true;
            then = new ArrayList<>(onSettled);
            onSettled.clear();
        }
        for (Runnable each : then) each.run();
    }

    /**
     * Through the switcher's own link, which a switch then adopts: the probe is the warm-up. Once the link is
     * ready, its health gives the counts. No keys reads as removed. The link on screen keeps its own listener.
     */
    public static Probe relayProbe(RelayConnections relay, Executor work) {
        return (server, report) -> {
            if (relay == null) {
                report.reading(Reading.OFFLINE);
                report.done();
                return;
            }
            RelayLink link = relay.warm(server);
            if (link == null) {
                report.reading(Reading.of(RelayStatus.Kind.DEVICE_REMOVED));
                report.done();
                return;
            }
            AtomicBoolean counted = new AtomicBoolean();
            Consumer<RelayStatus.Kind> seen = kind -> {
                report.reading(relayReading(kind));
                if (!DeviceSwitch.answered(kind)) return;
                if (kind != RelayStatus.Kind.READY) {
                    report.done();
                    return;
                }
                if (!counted.compareAndSet(false, true)) return;
                execute(work, report, () -> {
                    HealthAnswer answer = relay.health(link);
                    report.reading(healthReading(answer));
                    report.health(answer);
                    report.done();
                });
            };
            if (relay.warming(server.id)) link.setListener(status -> seen.accept(status.kind));
            // A link warmed by an earlier open may have settled already, and a listener hears only changes.
            seen.accept(link.status().kind);
        };
    }

    /** Ready means only that the relay took the phone: the cezar's own answer makes it online (PR #2340 smoke). */
    static Reading relayReading(RelayStatus.Kind kind) {
        return kind == RelayStatus.Kind.READY ? Reading.CHECKING : Reading.of(kind);
    }

    /** A ready link's health: no answer through the tunnel reads offline, so a cezar that stopped answering does. */
    static Reading healthReading(HealthAnswer answer) {
        return answer == null ? Reading.OFFLINE : Reading.of(answer.kind);
    }

    /** A direct server's health, with its saved password and the cookies `cookies` reads. */
    public static Probe directProbe(ShellConnector connector, Function<ServerRecord, String> cookies, Executor work) {
        return (server, report) -> execute(work, report, () -> {
            HealthAnswer answer = connector.health(server.id, cookies.apply(server));
            report.reading(answer == null ? Reading.OFFLINE : Reading.of(answer.kind));
            report.health(answer);
            report.done();
        });
    }

    /** A failed probe reads offline; a closed executor means the probing ended first. */
    private static void execute(Executor work, Report report, Runnable probe) {
        try {
            work.execute(() -> {
                try {
                    probe.run();
                } catch (RuntimeException e) {
                    report.reading(Reading.OFFLINE);
                    report.done();
                }
            });
        } catch (RejectedExecutionException e) {
            // Stopped.
        }
    }
}
