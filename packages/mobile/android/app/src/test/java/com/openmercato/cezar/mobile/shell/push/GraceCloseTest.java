package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.junit.Test;

/** The socket closes 30 s after the screen stops, unless it starts again first (spec R5 as built). */
public class GraceCloseTest {
    /** A main-thread handler on a fake clock. */
    private static final class FakeScheduler implements GraceClose.Scheduler {
        final List<long[]> due = new ArrayList<>();
        final List<Runnable> tasks = new ArrayList<>();
        long now;

        @Override public void schedule(Runnable task, long delayMs) {
            due.add(new long[] {now + delayMs});
            tasks.add(task);
        }

        @Override public void cancel(Runnable task) {
            for (int i = tasks.size() - 1; i >= 0; i--) {
                if (tasks.get(i) == task) {
                    tasks.remove(i);
                    due.remove(i);
                }
            }
        }

        void advance(long ms) {
            now += ms;
            List<Runnable> run = new ArrayList<>();
            Iterator<long[]> at = due.iterator();
            Iterator<Runnable> task = tasks.iterator();
            while (at.hasNext()) {
                long when = at.next()[0];
                Runnable next = task.next();
                if (when <= now) {
                    at.remove();
                    task.remove();
                    run.add(next);
                }
            }
            for (Runnable next : run) next.run();
        }
    }

    private final FakeScheduler clock = new FakeScheduler();
    private int closes;
    private final GraceClose grace = new GraceClose(clock, () -> closes++);

    @Test
    public void theSocketClosesThirtySecondsAfterStop() {
        assertTrue("first start opens", grace.started());
        grace.stopped();
        assertTrue(grace.pending());
        clock.advance(GraceClose.GRACE_MS - 1);
        assertEquals("still open inside the window", 0, closes);
        clock.advance(1);
        assertEquals(1, closes);
        assertFalse(grace.pending());
        clock.advance(GraceClose.GRACE_MS * 4);
        assertEquals("once per stop", 1, closes);
        assertTrue("a start after the close must start the link again", grace.started());
    }

    @Test
    public void startingAgainInsideTheWindowKeepsTheSocket() {
        grace.started();
        grace.stopped();
        clock.advance(20_000);
        assertFalse("the socket never closed", grace.started());
        assertFalse(grace.pending());
        clock.advance(GraceClose.GRACE_MS * 2);
        assertEquals(0, closes);
        grace.stopped();
        clock.advance(GraceClose.GRACE_MS);
        assertEquals("the second stop gets its own full window", 1, closes);
    }

    @Test
    public void aSecondStopDoesNotExtendTheWindow() {
        grace.started();
        grace.stopped();
        clock.advance(10_000);
        grace.stopped();
        clock.advance(20_000);
        assertEquals(1, closes);
        assertEquals(0, clock.tasks.size());
    }

    @Test
    public void aStopBeforeAnyStartAndADestroyCloseNothing() {
        grace.stopped();
        assertFalse(grace.pending());
        grace.started();
        grace.stopped();
        grace.cancel();
        clock.advance(GraceClose.GRACE_MS * 2);
        assertEquals("the destroyed view's link goes with it, not by this timer", 0, closes);
        assertEquals(0, clock.tasks.size());
    }
}
