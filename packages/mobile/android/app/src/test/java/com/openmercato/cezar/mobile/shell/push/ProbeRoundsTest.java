package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import org.junit.Test;

/** The single-flight probe round Your cezars and the badge rounds share (B1). */
public class ProbeRoundsTest {
    private final List<Consumer<RuntimeException>> running = new ArrayList<>();
    private final Set<String> saved = new HashSet<>(Arrays.asList("a", "b"));
    private int ended;

    private ProbeRounds rounds() {
        return new ProbeRounds(running::add, () -> saved, () -> ended++);
    }

    @Test
    public void aCallDuringARoundJoinsItAndEveryCallerIsAnswered() {
        ProbeRounds rounds = rounds();
        List<String> answers = new ArrayList<>();
        rounds.join(error -> {
            answers.add("first");
            throw new IllegalStateException("a failing caller");
        });
        rounds.join(error -> answers.add("second " + error));
        assertEquals("one round for both", 1, running.size());
        running.remove(0).accept(null);
        assertEquals(1, ended);
        assertEquals("a failing caller skips no one", Arrays.asList("first", "second null"), answers);
        rounds.join(error -> answers.add("later"));
        assertEquals("a later call runs anew", 1, running.size());
    }

    @Test
    public void aCezarSavedDuringARoundGetsAFollowUpRound() {
        ProbeRounds rounds = rounds();
        List<String> answers = new ArrayList<>();
        rounds.join(error -> answers.add("first"));
        saved.add("c");
        rounds.join(error -> answers.add("with c"));
        rounds.join(error -> answers.add("with c too"));
        assertEquals(1, running.size());
        running.remove(0).accept(null);
        assertEquals("the first round answers its own caller only", Arrays.asList("first"), answers);
        assertEquals("a follow-up round starts for the rest", 1, running.size());
        running.remove(0).accept(null);
        assertEquals(Arrays.asList("first", "with c", "with c too"), answers);
        assertEquals(2, ended);
    }

    @Test
    public void aRoundThatCannotStartAnswersWithItsError() {
        List<RuntimeException> errors = new ArrayList<>();
        ProbeRounds rounds = new ProbeRounds(settled -> {
            throw new IllegalStateException("no relay");
        }, () -> saved, () -> ended++);
        rounds.join(errors::add);
        assertEquals("no relay", errors.get(0).getMessage());
        rounds.join(errors::add);
        assertEquals("the next call tries again", 2, errors.size());
    }
}
