package com.openmercato.cezar.mobile.shell.push;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * One probe round over every saved cezar at a time (spec 2026-11-20-phone-notifications-inbox, B1): a round's end cools
 * every warm link, so two at once would cut each other short. A call during one joins it, unless a cezar was saved since
 * it began: that call gets a follow-up round, which reads it.
 */
public final class ProbeRounds {
    /** Starts a round; `settled` runs once, with null or the error that stopped it. */
    public interface Round {
        void start(Consumer<RuntimeException> settled);
    }

    private final Round round;
    private final Supplier<Set<String>> saved;
    private final Runnable ended;
    private List<Consumer<RuntimeException>> waiters;
    private Set<String> covering;
    private List<Consumer<RuntimeException>> next;

    /** `saved`: the saved cezars' ids now. `ended` runs once per round, before its callers. */
    public ProbeRounds(Round round, Supplier<Set<String>> saved, Runnable ended) {
        this.round = round;
        this.saved = saved;
        this.ended = ended;
    }

    public void join(Consumer<RuntimeException> done) {
        Set<String> now = new HashSet<>(saved.get());
        synchronized (this) {
            if (waiters != null) {
                if (covering.containsAll(now)) waiters.add(done);
                else {
                    if (next == null) next = new ArrayList<>();
                    next.add(done);
                }
                return;
            }
            waiters = new ArrayList<>();
            waiters.add(done);
            covering = now;
        }
        try {
            round.start(this::end);
        } catch (RuntimeException e) {
            end(e);
        }
    }

    private void end(RuntimeException error) {
        List<Consumer<RuntimeException>> answered;
        List<Consumer<RuntimeException>> again;
        synchronized (this) {
            if (waiters == null) return;
            answered = waiters;
            again = next;
            waiters = null;
            covering = null;
            next = null;
        }
        quietly(ended);
        // One caller's failure must not skip the next: a badge round left unanswered never runs again.
        for (Consumer<RuntimeException> each : answered) quietly(() -> each.accept(error));
        if (again != null) for (Consumer<RuntimeException> each : again) join(each);
    }

    private static void quietly(Runnable work) {
        try {
            work.run();
        } catch (RuntimeException ignored) {
            // The failing caller's own problem.
        }
    }
}
