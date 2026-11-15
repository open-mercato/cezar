package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.DeviceSwitch.Status;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import org.junit.Test;

/** The device switcher's pure decisions (shared contract with iOS: dots, spoken rows, landing). */
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

    @Test
    public void aRowSpeaksItsLabelStatusAndWhetherItIsCurrent() {
        assertEquals("Patryk's MacBook Pro, connected, current", DeviceSwitch.spoken("Patryk's MacBook Pro", Status.CONNECTED, true));
        assertEquals("Studio, needs attention", DeviceSwitch.spoken("Studio", Status.ATTENTION, false));
        assertEquals("Studio, switching", DeviceSwitch.spoken("Studio", Status.SWITCHING, false));
    }

    @Test
    public void theSecondLineIsTheRelayOrTheHost() {
        assertEquals("Through the relay", DeviceSwitch.detail(new ServerRecord("a", "Mac", new RelayFields("https://relay.example.test", "c", "k", "d", 0), null)));
        assertEquals("box.example.com", DeviceSwitch.detail(new ServerRecord("b", "Box", "https://box.example.com", null, null, null)));
    }
}
