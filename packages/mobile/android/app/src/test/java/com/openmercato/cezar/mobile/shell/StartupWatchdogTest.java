package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;

import com.openmercato.cezar.mobile.shell.StartupWatchdog.Kind;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import org.junit.Test;

/** Every way a start can fail ends in the page or the Connection problem panel, on the timer alone. */
public class StartupWatchdogTest {
    private long now = 1000;
    private final StartupWatchdog relay = new StartupWatchdog("pe.local", true);

    private StartupWatchdog.Decision at(long ms) {
        now = 1000 + ms;
        return relay.decide(now);
    }

    private void status(RelayStatus.Kind kind) {
        relay.relayStatus(kind, now);
    }

    @Test
    public void saysWhatItWaitsForBeforeAndAfterTheSession() {
        relay.start(now);
        status(RelayStatus.Kind.CONNECTING);
        assertEquals("Connecting to pe.local…", at(300).text);
        status(RelayStatus.Kind.READY);
        assertEquals(StartupWatchdog.LOADING, at(900).text);
    }

    @Test
    public void aPaintedPageShowsAtOnce() {
        relay.start(now);
        status(RelayStatus.Kind.READY);
        relay.firstByte(now);
        relay.painted();
        assertEquals(Kind.REVEAL, at(10).kind);
    }

    @Test
    public void anUnreachableRelayEndsInTheProblemPanelWithItsReason() {
        relay.start(now);
        status(RelayStatus.Kind.RELAY_DOWN);
        assertEquals(Kind.WAIT, at(StartupWatchdog.CONNECT_MS - 1).kind);
        StartupWatchdog.Decision decision = at(StartupWatchdog.CONNECT_MS);
        assertEquals(Kind.PROBLEM, decision.kind);
        assertEquals("Can't reach the Cezar relay.", decision.text);
    }

    @Test
    public void aSilentHandshakeOrAnAsleepComputerSaySo() {
        relay.start(now);
        status(RelayStatus.Kind.NOT_ANSWERING);
        assertEquals("cezar is not answering the secure handshake.", at(StartupWatchdog.CONNECT_MS).text);
        StartupWatchdog offline = new StartupWatchdog("pe.local", true);
        offline.start(0);
        offline.relayStatus(RelayStatus.Kind.CEZAR_OFFLINE, 0);
        assertEquals("Your computer is asleep or cezar isn't running.", offline.decide(StartupWatchdog.CONNECT_MS).text);
    }

    @Test
    public void aConnectThatNeverSettlesTimesOut() {
        relay.start(now);
        status(RelayStatus.Kind.CONNECTING);
        assertEquals("The relay connection timed out.", at(StartupWatchdog.CONNECT_MS).text);
    }

    @Test
    public void aSessionWithNoFirstByteIsAProblem() {
        relay.start(now);
        at(2000);
        status(RelayStatus.Kind.READY);
        assertEquals(Kind.WAIT, at(2000 + StartupWatchdog.FIRST_BYTE_MS - 1).kind);
        StartupWatchdog.Decision decision = at(2000 + StartupWatchdog.FIRST_BYTE_MS);
        assertEquals(Kind.PROBLEM, decision.kind);
        assertEquals("Connected, but cezar did not send the cockpit.", decision.text);
    }

    @Test
    public void aPageThatNeverFinishesLoadingIsAProblem() {
        relay.start(now);
        status(RelayStatus.Kind.READY);
        at(500);
        relay.firstByte(now);
        assertEquals(Kind.WAIT, at(500 + StartupWatchdog.LOAD_MS - 1).kind);
        assertEquals(Kind.PROBLEM, at(500 + StartupWatchdog.LOAD_MS).kind);
    }

    @Test
    public void thePaintSignalIsOptionalAfterTheLoadEvent() {
        // An older cockpit, or paint answers lost with their document: the page shows anyway.
        relay.start(now);
        status(RelayStatus.Kind.READY);
        at(800);
        relay.loaded(now);
        assertEquals(Kind.WAIT, at(800 + StartupWatchdog.PAINT_GRACE_MS - 1).kind);
        assertEquals(Kind.REVEAL, at(800 + StartupWatchdog.PAINT_GRACE_MS).kind);
    }

    @Test
    public void aCachedPageShowsWithTheRelayDownAndTheBannerTakesOver() {
        relay.start(now);
        status(RelayStatus.Kind.RELAY_DOWN);
        at(150);
        relay.loaded(now);
        relay.painted();
        assertEquals(Kind.REVEAL, at(200).kind);
    }

    @Test
    public void aTerminalRelayStateWithNothingOnScreenIsAProblemAtOnce() {
        relay.start(now);
        status(RelayStatus.Kind.UPDATE_CEZAR);
        assertEquals(Kind.PROBLEM, at(50).kind);
        assertEquals("Update cezar on your computer: this app needs a newer one.", at(60).text);
    }

    @Test
    public void aFailedMainFrameBeatsItsOwnErrorPageAndRetryStartsClean() {
        relay.start(now);
        relay.failed("No connection to cezar came up in time.");
        relay.firstByte(now);
        relay.painted();
        assertEquals(Kind.PROBLEM, at(10).kind);
        assertEquals("settled until the next start", Kind.PROBLEM, at(20).kind);
        relay.start(now);
        status(RelayStatus.Kind.READY);
        relay.painted();
        assertEquals(Kind.REVEAL, at(30).kind);
    }

    @Test
    public void nothingOutlastsTheHardCap() {
        relay.start(now);
        status(RelayStatus.Kind.READY);
        at(StartupWatchdog.MAX_MS - 5000);
        status(RelayStatus.Kind.CONNECTING);
        status(RelayStatus.Kind.READY);
        assertEquals(Kind.PROBLEM, at(StartupWatchdog.MAX_MS).kind);
    }

    @Test
    public void aDirectServerHasNoRelayStepToWaitFor() {
        StartupWatchdog direct = new StartupWatchdog("lab", false);
        direct.start(0);
        assertEquals(StartupWatchdog.LOADING, direct.decide(10).text);
        assertEquals(Kind.PROBLEM, direct.decide(StartupWatchdog.FIRST_BYTE_MS).kind);
    }

    @Test
    public void everyDeadlineFitsUnderTheCap() {
        assertEquals(true, StartupWatchdog.CONNECT_MS + StartupWatchdog.FIRST_BYTE_MS <= StartupWatchdog.MAX_MS);
        assertEquals(true, StartupWatchdog.PAINT_GRACE_MS <= 2000);
    }
}
