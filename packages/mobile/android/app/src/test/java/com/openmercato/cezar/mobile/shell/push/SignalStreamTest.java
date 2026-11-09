package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Random;
import org.junit.Test;

/** The stream's life inside a session: reopen while wanted, stop on 404 and 409 (spec R5, Stage 1). */
public class SignalStreamTest {
    private static final String READY = "event: ready\ndata: {}\n\n";

    /** One scripted answer: a status, then chunks, then the end. A null chunk is a read that timed out. */
    private static class Script implements SignalStream.Connection {
        final int status;
        final Deque<byte[]> chunks = new ArrayDeque<>();
        boolean closed;
        boolean timedOut;

        Script(int status, String... chunks) {
            this.status = status;
            for (String chunk : chunks) this.chunks.add(chunk == null ? new byte[0] : chunk.getBytes(StandardCharsets.UTF_8));
        }

        @Override public int status() {
            return status;
        }

        @Override public byte[] read(long timeoutMs) throws IOException {
            assertEquals(SignalStream.SILENCE_MS, timeoutMs);
            byte[] next = chunks.poll();
            if (next == null) throw new EOFException();
            if (next.length == 0) {
                timedOut = true;
                return null;
            }
            return next;
        }

        @Override public void close() {
            closed = true;
        }
    }

    private final Deque<Object> answers = new ArrayDeque<>();
    private final List<Script> opened = new ArrayList<>();
    private final List<String> signals = new ArrayList<>();
    private final List<Long> sleeps = new ArrayList<>();
    private int wantedFor = Integer.MAX_VALUE;
    private int asked;

    private SignalStream stream() {
        return new SignalStream(() -> {
            Object next = answers.poll();
            if (next == null || next instanceof IOException) throw next == null ? new IOException("no session") : (IOException) next;
            opened.add((Script) next);
            return (Script) next;
        }, () -> asked++ < wantedFor, managerId -> signals.add(String.valueOf(managerId)), new Random(1), sleeps::add);
    }

    @Test
    public void statusesDecideReadStopOrRetry() {
        assertEquals(SignalStream.Next.READ, SignalStream.decide(200));
        assertEquals("unknown device, or a cezar without the route", SignalStream.Next.STOP, SignalStream.decide(404));
        assertEquals("CEZ_PUSH=0", SignalStream.Next.STOP, SignalStream.decide(409));
        for (int status : new int[] {403, 500, 502, 503}) assertEquals(SignalStream.Next.RETRY, SignalStream.decide(status));
    }

    @Test
    public void signalsReachTheListenerWithAPlainManagerOnly() {
        answers.add(new Script(200, READY, "event: signal\ndata: {\"managerId\":\"mgr_1\"}\n\n", "event: ping\ndata: \n\n",
                "event: signal\ndata: {}\n\n", "event: signal\ndata: {\"managerId\":\"../x\"}\n\n", "event: signal\ndata: not json\n\n",
                "event: surprise\ndata: {}\n\n"));
        wantedFor = 2;
        assertEquals(SignalStream.End.NO_SESSION, stream().run());
        assertEquals(Arrays.asList("mgr_1", "null", "null"), signals);
        assertTrue(opened.get(0).closed);
    }

    @Test
    public void notFoundAndConflictStopWithoutAnotherTry() {
        for (int status : new int[] {404, 409}) {
            answers.clear();
            opened.clear();
            sleeps.clear();
            answers.add(new Script(status));
            answers.add(new Script(200, READY));
            assertEquals(SignalStream.End.REFUSED, stream().run());
            assertEquals(1, opened.size());
            assertTrue(opened.get(0).closed);
            assertTrue("no wait, no retry", sleeps.isEmpty());
        }
    }

    @Test
    public void aRefusalKeepsEnsureRunningFromStartingAgain() {
        answers.add(new Script(409));
        SignalStream stream = stream();
        stream.ensureRunning(Runnable::run);
        stream.ensureRunning(Runnable::run);
        assertEquals("one open per view after a refusal", 1, opened.size());
    }

    @Test
    public void anEndedStreamReopensWithBackoffWhileTheSessionLasts() {
        answers.add(new IOException("no session yet"));
        answers.add(new Script(503));
        answers.add(new Script(200, READY));
        answers.add(new Script(200, READY, null));
        answers.add(new Script(200));
        wantedFor = 10;
        assertEquals(SignalStream.End.NO_SESSION, stream().run());
        assertEquals(4, opened.size());
        assertTrue("silence past three pings ends the stream", opened.get(2).timedOut);
        assertEquals(5, sleeps.size());
        for (long sleep : sleeps) assertTrue(sleep >= 1000 && sleep <= SignalStream.MAX_BACKOFF_MS);
        assertTrue("two failures grow the cap", sleeps.get(1) <= 4000);
        assertTrue("a ready resets it", sleeps.get(2) <= 2000 && sleeps.get(3) <= 2000);
    }

    @Test
    public void backoffIsCappedAtAMinute() {
        SignalStream stream = stream();
        for (int attempts = 0; attempts < 40; attempts++) {
            long delay = stream.backoffMs(attempts);
            assertTrue(delay >= 1000 && delay <= 60_000);
        }
    }

    @Test
    public void noSessionMeansNoOpen() {
        wantedFor = 0;
        answers.add(new Script(200, READY));
        assertEquals(SignalStream.End.NO_SESSION, stream().run());
        assertTrue(opened.isEmpty());
    }

    @Test
    public void stopClosesTheOpenStreamAndEndsTheLoop() {
        SignalStream[] holder = new SignalStream[1];
        Script script = new Script(200, READY) {
            @Override public byte[] read(long timeoutMs) throws IOException {
                byte[] next = super.read(timeoutMs);
                holder[0].stop();
                return next;
            }
        };
        answers.add(script);
        holder[0] = stream();
        assertEquals(SignalStream.End.STOPPED, holder[0].run());
        assertTrue(script.closed);
        assertTrue(sleeps.isEmpty());
        holder[0].ensureRunning(run -> {
            throw new AssertionError("a stopped stream never starts");
        });
    }

    @Test
    public void aListenerThatThrowsDoesNotEndTheStream() {
        answers.add(new Script(200, READY, "event: signal\ndata: {}\n\n", "event: signal\ndata: {}\n\n"));
        int[] calls = {0};
        wantedFor = 2;
        SignalStream stream = new SignalStream(() -> (Script) answers.poll(), () -> asked++ < wantedFor, managerId -> {
            calls[0]++;
            throw new IllegalStateException("posting failed");
        }, new Random(1), sleeps::add);
        assertEquals(SignalStream.End.NO_SESSION, stream.run());
        assertEquals(2, calls[0]);
        assertNull(answers.poll());
        assertFalse(sleeps.isEmpty());
    }
}
