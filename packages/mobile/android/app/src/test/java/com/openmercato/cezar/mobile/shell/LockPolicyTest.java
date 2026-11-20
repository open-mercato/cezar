package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LockPolicyTest {
    private static final long START = 1_000_000;

    private static LockPolicy unlocked() {
        LockPolicy policy = new LockPolicy();
        policy.passed();
        return policy;
    }

    @Test
    public void aNewProcessPromptsOnLaunch() {
        LockPolicy policy = new LockPolicy();
        assertTrue(policy.promptNeeded(true));
        assertTrue(policy.autoPrompt(true));
    }

    @Test
    public void disabledNeverPrompts() {
        LockPolicy policy = new LockPolicy();
        assertFalse(policy.promptNeeded(false));
        assertFalse(policy.autoPrompt(false));
        policy.left(START, false);
        policy.returned(START + LockPolicy.TIMEOUT_MS * 10);
        assertFalse(policy.promptNeeded(false));
    }

    @Test
    public void justUnderTheTimeoutStaysUnlocked() {
        LockPolicy policy = unlocked();
        policy.left(START, false);
        policy.returned(START + LockPolicy.TIMEOUT_MS - 1);
        assertFalse(policy.promptNeeded(true));
    }

    @Test
    public void exactlyTheTimeoutLocks() {
        LockPolicy policy = unlocked();
        policy.left(START, false);
        policy.returned(START + LockPolicy.TIMEOUT_MS);
        assertTrue(policy.promptNeeded(true));
    }

    @Test
    public void awayTimeIsPerTripNotCumulative() {
        LockPolicy policy = unlocked();
        policy.left(START, false);
        policy.returned(START + LockPolicy.TIMEOUT_MS - 1);
        policy.left(START + LockPolicy.TIMEOUT_MS, false);
        policy.returned(START + LockPolicy.TIMEOUT_MS * 2 - 1);
        assertFalse(policy.promptNeeded(true));
    }

    @Test
    public void aRotationIsNotLeaving() {
        LockPolicy policy = unlocked();
        policy.left(START, true);
        policy.returned(START + LockPolicy.TIMEOUT_MS * 10);
        assertFalse(policy.promptNeeded(true));
    }

    @Test
    public void aRotationWhileLockedStaysLockedWithoutASecondPrompt() {
        LockPolicy policy = new LockPolicy();
        policy.promptStarted();
        policy.left(START, true);
        policy.returned(START + 1);
        assertTrue(policy.promptNeeded(true));
        assertFalse(policy.autoPrompt(true));
    }

    /** elapsedRealtime never runs backwards. If a caller's clock ever does, the lock wins. */
    @Test
    public void aClockThatRunsBackwardsLocks() {
        LockPolicy policy = unlocked();
        policy.left(START, false);
        policy.returned(START - 1);
        assertTrue(policy.promptNeeded(true));
    }

    @Test
    public void aCancelledPromptStaysLockedWithNoAutomaticLoop() {
        LockPolicy policy = new LockPolicy();
        policy.promptStarted();
        policy.left(START, false); // A full-screen credential page stops the activity.
        policy.promptEnded();
        policy.returned(START + 1);
        assertTrue(policy.promptNeeded(true));
        assertFalse(policy.autoPrompt(true));
    }

    @Test
    public void aRealTripAwayOffersThePromptAgain() {
        LockPolicy policy = new LockPolicy();
        policy.promptStarted();
        policy.promptEnded();
        policy.left(START, false);
        policy.returned(START + 1);
        assertTrue(policy.autoPrompt(true));
    }

    @Test
    public void leavingDuringAToggleCountsTowardsTheTimeout() {
        LockPolicy policy = unlocked();
        policy.promptStarted();
        policy.left(START, false);
        policy.promptEnded();
        policy.returned(START + LockPolicy.TIMEOUT_MS);
        assertTrue(policy.promptNeeded(true));
    }

    @Test
    public void passingClearsAnEarlierDeparture() {
        LockPolicy policy = new LockPolicy();
        policy.left(START, false);
        policy.passed();
        policy.returned(START + LockPolicy.TIMEOUT_MS * 10);
        assertFalse(policy.promptNeeded(true));
    }
}
