package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** One round of probes: bound, settle, the book, and release (shared by the switcher sheet and Your cezars). */
public class DeviceProbesTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final Map<String, DeviceProbes.Report> reports = new HashMap<>();
    private final List<Runnable> bound = new ArrayList<>();
    private final List<String> released = new ArrayList<>();
    private final List<String> booked = new ArrayList<>();
    private final List<String> changes = new ArrayList<>();

    private final DeviceProbes.Probe capture = (server, report) -> reports.put(server.id, report);
    private final DeviceProbes probes = new DeviceProbes(capture, capture, released::add, (ms, work) -> {
        assertEquals(DeviceSwitch.PROBE_MS, ms);
        bound.add(work);
    }, (id, answer) -> booked.add(id), (id, reading) -> changes.add(id + ":" + reading.status + ":" + reading.kind));

    private static ServerRecord server(String id) {
        return new ServerRecord(id, id, "https://" + id + ".example", null, null, null);
    }

    @Test
    public void aReadyRelayLinkWaitsForTheCezarsOwnAnswer() {
        // PR #2340 smoke: a killed cezar behind a still-ready link read online.
        assertSame(DeviceProbes.Reading.CHECKING, DeviceProbes.relayReading(RelayStatus.Kind.READY));
        assertEquals(DeviceSwitch.Status.CONNECTED, DeviceProbes.healthReading(HealthAnswer.of(HealthAnswer.Kind.CEZAR, 200)).status);
        assertSame(DeviceProbes.Reading.OFFLINE, DeviceProbes.healthReading(null));
        assertEquals(DeviceSwitch.Status.OFFLINE, DeviceProbes.healthReading(HealthAnswer.of(HealthAnswer.Kind.UNREACHABLE, 200)).status);
        assertEquals(DeviceSwitch.Status.OFFLINE, DeviceProbes.relayReading(RelayStatus.Kind.CEZAR_OFFLINE).status);
    }

    @Test
    public void everyServerStartsChecking() {
        probes.start(Arrays.asList(server("a"), server("b")));
        assertSame(DeviceProbes.Reading.CHECKING, probes.snapshot().get("a"));
        assertSame(DeviceProbes.Reading.CHECKING, probes.snapshot().get("b"));
        assertTrue(changes.isEmpty());
    }

    @Test
    public void settlesWhenEveryProbeIsDone() {
        int[] settled = {0};
        probes.whenSettled(() -> settled[0]++);
        probes.start(Arrays.asList(server("a"), server("b")));
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        reports.get("a").done();
        assertEquals(0, settled[0]);
        reports.get("b").reading(DeviceProbes.Reading.OFFLINE);
        reports.get("b").done();
        assertEquals(1, settled[0]);
        bound.get(0).run();
        assertEquals(1, settled[0]);
        assertEquals(DeviceSwitch.Status.CONNECTED, probes.snapshot().get("a").status);
    }

    @Test
    public void theBoundTurnsCheckingOfflineAndSettles() {
        int[] settled = {0};
        probes.start(Arrays.asList(server("a"), server("b")));
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        bound.get(0).run();
        probes.whenSettled(() -> settled[0]++);
        assertEquals(1, settled[0]);
        assertEquals(DeviceSwitch.Status.CONNECTED, probes.snapshot().get("a").status);
        assertSame(DeviceProbes.Reading.OFFLINE, probes.snapshot().get("b"));
        // A still-connecting link stays offline; a real answer still turns it.
        reports.get("b").reading(DeviceProbes.Reading.CHECKING);
        assertSame(DeviceProbes.Reading.OFFLINE, probes.snapshot().get("b"));
        reports.get("b").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        assertEquals(DeviceSwitch.Status.CONNECTED, probes.snapshot().get("b").status);
    }

    @Test
    public void noServersSettlesAtOnce() {
        int[] settled = {0};
        probes.whenSettled(() -> settled[0]++);
        probes.start(Collections.emptyList());
        assertEquals(1, settled[0]);
    }

    @Test
    public void aCezarsHealthGoesInTheBookAndRepeatsTheReading() {
        probes.start(Collections.singletonList(server("a")));
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        changes.clear();
        reports.get("a").health(HealthAnswer.of(HealthAnswer.Kind.CEZAR, 200));
        reports.get("a").health(HealthAnswer.of(HealthAnswer.Kind.LOGIN_PAGE, 302));
        reports.get("a").health(null);
        assertEquals(Collections.singletonList("a"), booked);
        assertEquals(Collections.singletonList("a:CONNECTED:CEZAR"), changes);
    }

    @Test
    public void stopReleasesOnceAndIgnoresLaterReports() {
        probes.start(Collections.singletonList(server("a")));
        probes.stop("a");
        probes.stop(null);
        assertEquals(Collections.singletonList("a"), released);
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        assertSame(DeviceProbes.Reading.CHECKING, probes.snapshot().get("a"));
        assertTrue(changes.isEmpty());
    }

    @Test
    public void aRepeatedReadingIsNoChange() {
        probes.start(Collections.singletonList(server("a")));
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        reports.get("a").reading(DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        assertEquals(1, changes.size());
    }

    @Test
    public void aFailedDirectProbeReadsOffline() {
        ServerListStore servers = new ServerListStore(folder.getRoot());
        servers.put(server("a"));
        HttpGet broken = (url, headers) -> {
            throw new IllegalStateException("boom");
        };
        DeviceProbes.Probe failing = DeviceProbes.directProbe(new ShellConnector(servers, null, new HealthProbe(broken, "test")), server -> null, Runnable::run);
        boolean[] done = {false};
        DeviceProbes.Reading[] seen = {null};
        failing.start(server("a"), new DeviceProbes.Report() {
            @Override public void reading(DeviceProbes.Reading reading) {
                seen[0] = reading;
            }

            @Override public void health(HealthAnswer answer) {}

            @Override public void done() {
                done[0] = true;
            }
        });
        assertSame(DeviceProbes.Reading.OFFLINE, seen[0]);
        assertTrue(done[0]);
        assertFalse(released.contains("a"));
        assertNull(probes.snapshot().get("a"));
    }
}
