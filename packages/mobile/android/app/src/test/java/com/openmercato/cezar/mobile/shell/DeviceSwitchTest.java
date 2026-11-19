package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.DeviceSwitch.Status;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import org.junit.Test;

/** The device switcher's pure decisions (shared contract with iOS: words, order, spoken rows, landing). */
public class DeviceSwitchTest {
    @Test
    public void aLiveRelaySessionReadsConnected() {
        assertEquals(Status.CONNECTED, DeviceSwitch.of(RelayStatus.Kind.READY));
    }

    @Test
    public void relayFailuresReadOffline() {
        for (RelayStatus.Kind kind : new RelayStatus.Kind[] {RelayStatus.Kind.IDLE, RelayStatus.Kind.CONNECTING, RelayStatus.Kind.RELAY_DOWN,
                RelayStatus.Kind.CEZAR_OFFLINE, RelayStatus.Kind.NOT_ANSWERING, RelayStatus.Kind.QUOTA, RelayStatus.Kind.BROKEN}) {
            assertEquals(kind.name(), Status.OFFLINE, DeviceSwitch.of(kind));
        }
    }

    @Test
    public void emailTermsAndAnOldCezarNeedAttention() {
        for (RelayStatus.Kind kind : new RelayStatus.Kind[] {RelayStatus.Kind.EMAIL_UNCONFIRMED, RelayStatus.Kind.ACCOUNT_REQUIRED,
                RelayStatus.Kind.UPDATE_APP, RelayStatus.Kind.UPDATE_CEZAR}) {
            assertEquals(kind.name(), Status.ATTENTION, DeviceSwitch.of(kind));
        }
    }

    @Test
    public void suspendedTermsRequiredAndRemovedAreBlocked() {
        for (RelayStatus.Kind kind : new RelayStatus.Kind[] {RelayStatus.Kind.SUSPENDED, RelayStatus.Kind.TERMS_REQUIRED_DEVICE, RelayStatus.Kind.DEVICE_REMOVED}) {
            assertEquals(kind.name(), Status.BLOCKED, DeviceSwitch.of(kind));
        }
    }

    @Test
    public void everyRelayKindHasAStatus() {
        for (RelayStatus.Kind kind : RelayStatus.Kind.values()) DeviceSwitch.of(kind);
        for (HealthAnswer.Kind kind : HealthAnswer.Kind.values()) DeviceSwitch.of(kind);
    }

    @Test
    public void connectingIsNoAnswerYet() {
        assertFalse(DeviceSwitch.answered(RelayStatus.Kind.CONNECTING));
        assertFalse(DeviceSwitch.answered(RelayStatus.Kind.IDLE));
        assertTrue(DeviceSwitch.answered(RelayStatus.Kind.READY));
        assertTrue(DeviceSwitch.answered(RelayStatus.Kind.CEZAR_OFFLINE));
    }

    @Test
    public void directHealthMapsToTheSameDots() {
        assertEquals(Status.CONNECTED, DeviceSwitch.of(HealthAnswer.Kind.CEZAR));
        assertEquals(Status.ATTENTION, DeviceSwitch.of(HealthAnswer.Kind.BASIC_GATE));
        assertEquals(Status.ATTENTION, DeviceSwitch.of(HealthAnswer.Kind.LOGIN_PAGE));
        assertEquals(Status.OFFLINE, DeviceSwitch.of(HealthAnswer.Kind.UNREACHABLE));
        assertEquals(Status.OFFLINE, DeviceSwitch.of(HealthAnswer.Kind.TLS_FAILURE));
        assertEquals(Status.OFFLINE, DeviceSwitch.of(HealthAnswer.Kind.NOT_CEZAR));
        assertEquals(Status.BLOCKED, DeviceSwitch.of(HealthAnswer.Kind.DEVICE_REMOVED));
    }

    @Test
    public void managerStaysManagerAndTheRestLandOnTasks() {
        assertEquals("/manager", DeviceSwitch.landingPath("http://127.0.0.1:4242/manager"));
        assertEquals("/manager", DeviceSwitch.landingPath("https://box.example.com/manager/abc?x=1#y"));
        assertEquals("/manager", DeviceSwitch.landingPath("https://box.example.com/manager?tab=2"));
        assertEquals("/tasks", DeviceSwitch.landingPath("https://box.example.com/managers"));
        assertEquals("/tasks", DeviceSwitch.landingPath("https://box.example.com/p/abc/tasks/12"));
        assertEquals("/tasks", DeviceSwitch.landingPath("https://box.example.com/"));
        assertEquals("/tasks", DeviceSwitch.landingPath("https://box.example.com"));
        assertEquals("/tasks", DeviceSwitch.landingPath(null));
    }

    @SuppressWarnings("deprecation")
    private static long utc(int day, int hour, int minute) {
        return Date.UTC(126, 10, day, hour, minute, 0);
    }

    @Test
    public void rowsSpeakTheirNameWordsNeedAndWhetherCurrent() {
        assertEquals("Studio iMac, Online, current", DeviceSwitch.spoken("Studio iMac", "Online", 3, true));
        assertEquals("Build box, Offline since 14:02, 1 needs you", DeviceSwitch.spoken("Build box", "Offline since 14:02", 1, false));
        assertEquals("Home server, Suspended", DeviceSwitch.spoken("Home server", "Suspended", null, false));
    }

    @Test
    public void plainWordsForEveryKind() {
        DeviceSwitch.Clock clock = new DeviceSwitch.Clock(utc(15, 16, 30), TimeZone.getTimeZone("UTC"),
                new SimpleDateFormat("HH:mm", Locale.UK), new SimpleDateFormat("d MMM", Locale.UK));
        assertEquals("Online", DeviceSwitch.state(RelayStatus.Kind.READY, 0, clock).words);
        assertEquals("Online", DeviceSwitch.state(HealthAnswer.Kind.CEZAR, 0, clock).words);
        assertEquals("Email not confirmed", DeviceSwitch.state(RelayStatus.Kind.EMAIL_UNCONFIRMED, 0, clock).words);
        assertEquals("Suspended", DeviceSwitch.state(RelayStatus.Kind.SUSPENDED, 0, clock).words);
        assertEquals("Can't connect", DeviceSwitch.state(RelayStatus.Kind.RELAY_DOWN, 0, clock).words);
        assertEquals("Can't connect", DeviceSwitch.state(HealthAnswer.Kind.TLS_FAILURE, 0, clock).words);
        assertEquals("Sign in needed", DeviceSwitch.state(HealthAnswer.Kind.LOGIN_PAGE, 0, clock).words);
        assertEquals("Offline", DeviceSwitch.state(RelayStatus.Kind.CEZAR_OFFLINE, 0, clock).words);
        assertEquals("Offline since 14:02", DeviceSwitch.state(RelayStatus.Kind.CEZAR_OFFLINE, utc(15, 14, 2), clock).words);
        assertEquals("Offline since 12 Nov", DeviceSwitch.state(HealthAnswer.Kind.UNREACHABLE, utc(12, 9, 0), clock).words);
        assertEquals(Status.OFFLINE, DeviceSwitch.offline(utc(15, 14, 2), clock).status);
        for (RelayStatus.Kind kind : RelayStatus.Kind.values()) assertNotNull(kind.name(), DeviceSwitch.state(kind, 0, clock).words);
        for (HealthAnswer.Kind kind : HealthAnswer.Kind.values()) assertNotNull(kind.name(), DeviceSwitch.state(kind, 0, clock).words);
    }

    @Test
    public void needReadsInPlainWords() {
        assertNull(DeviceSwitch.needText(null));
        assertNull(DeviceSwitch.needText(0));
        assertEquals("1 needs you", DeviceSwitch.needText(1));
        assertEquals("12 need you", DeviceSwitch.needText(12));
    }

    @Test
    public void currentFirstThenOnlineThenOfflineThenTheRestByNeed() {
        List<DeviceSwitch.Entry> rows = Arrays.asList(
                new DeviceSwitch.Entry("blocked", Status.BLOCKED, 9),
                new DeviceSwitch.Entry("offline", Status.OFFLINE, 5),
                new DeviceSwitch.Entry("online-quiet", Status.CONNECTED, null),
                new DeviceSwitch.Entry("current", Status.OFFLINE, 0),
                new DeviceSwitch.Entry("online-busy", Status.CONNECTED, 2),
                new DeviceSwitch.Entry("checking", Status.CHECKING, 0),
                new DeviceSwitch.Entry("email", Status.ATTENTION, 1));
        assertEquals(Arrays.asList("current", "online-busy", "online-quiet", "offline", "checking", "blocked", "email"),
                DeviceSwitch.order(rows, "current"));
    }

    @Test
    public void oneComputerIsOneRow() {
        assertEquals(Arrays.asList("only"), DeviceSwitch.order(Arrays.asList(new DeviceSwitch.Entry("only", Status.CONNECTED, 4)), "only"));
    }
}
