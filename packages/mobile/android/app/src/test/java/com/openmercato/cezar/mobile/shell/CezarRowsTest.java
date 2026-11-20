package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Your cezars' listed rows, the reason keys and the rename rule (spec 2026-11-19-mobile-devices-screen). */
public class CezarRowsTest {
    private static final long NOW = 1_763_560_000_000L;
    private static final DeviceSwitch.Clock CLOCK = new DeviceSwitch.Clock(NOW, TimeZone.getTimeZone("UTC"),
            new SimpleDateFormat("HH:mm", Locale.ROOT), new SimpleDateFormat("d MMM", Locale.ROOT));

    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static ServerRecord direct(String id, String label) {
        return new ServerRecord(id, label, "https://" + id + ".example", null, null, null);
    }

    private static ServerRecord relay(String id, String label) {
        return new ServerRecord(id, label, new RelayFields("https://relay.example", "c-" + id, "k", "d", 0), null);
    }

    private static List<CezarRows.Row> rows(List<ServerRecord> servers, Map<String, DeviceProbes.Reading> readings, Map<String, ServerListStore.Seen> seen, String current) {
        return CezarRows.rows(servers, readings, seen, current, CLOCK);
    }

    @Test
    public void aRowCarriesItsIdentityStatusAndNeed() {
        Map<String, DeviceProbes.Reading> readings = new HashMap<>();
        readings.put("a", DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        Map<String, ServerListStore.Seen> seen = new HashMap<>();
        seen.put("a", new ServerListStore.Seen(NOW, 2, 1));
        CezarRows.Row row = rows(Collections.singletonList(direct("a", "pe local")), readings, seen, null).get(0);
        assertEquals("PL", row.initials);
        assertEquals(String.format("#%06x", Avatar.color("pe local") & 0xFFFFFF), row.color);
        assertEquals("online", row.status);
        assertEquals("Online", row.words);
        assertNull(row.reason);
        assertEquals(Integer.valueOf(3), row.need);
    }

    @Test
    public void colourIsLowercaseHexWithoutAlpha() {
        assertEquals("#7c6cf0", CezarRows.hex(0xFF7C6CF0));
    }

    @Test
    public void unprobedReadsCheckingAndNeverToldHasNoNeed() {
        CezarRows.Row row = rows(Collections.singletonList(relay("a", "")), new HashMap<>(), new HashMap<>(), null).get(0);
        assertEquals("", row.initials);
        assertEquals("checking", row.status);
        assertEquals("Checking…", row.words);
        assertNull(row.need);
    }

    @Test
    public void aBoundsOfflineSaysSince() {
        Map<String, DeviceProbes.Reading> readings = new HashMap<>();
        readings.put("a", DeviceProbes.Reading.OFFLINE);
        Map<String, ServerListStore.Seen> seen = new HashMap<>();
        seen.put("a", new ServerListStore.Seen(NOW - 60_000, null, null));
        CezarRows.Row row = rows(Collections.singletonList(direct("a", "box")), readings, seen, null).get(0);
        assertEquals("offline", row.status);
        assertEquals("Offline since " + new SimpleDateFormat("HH:mm", Locale.ROOT) {{ setTimeZone(TimeZone.getTimeZone("UTC")); }}.format(NOW - 60_000), row.words);
        assertNull(row.reason);
    }

    @Test
    public void blockedKindsAreOtherWithTheirReason() {
        Object[][] cases = {
            {HealthAnswer.Kind.BASIC_GATE, "sign-in", "Sign in needed"},
            {HealthAnswer.Kind.LOGIN_PAGE, "sign-in", "Sign in needed"},
            {RelayStatus.Kind.DEVICE_REMOVED, "removed", "This phone was removed"},
            {RelayStatus.Kind.EMAIL_UNCONFIRMED, "email", "Email not confirmed"},
            {RelayStatus.Kind.ACCOUNT_REQUIRED, "account", null},
            {RelayStatus.Kind.TERMS_REQUIRED_DEVICE, "terms", null},
            {RelayStatus.Kind.SUSPENDED, "suspended", null},
            {RelayStatus.Kind.UPDATE_APP, "update-app", null},
            {RelayStatus.Kind.UPDATE_CEZAR, "update-cezar", null},
            {RelayStatus.Kind.QUOTA, "quota", null},
            {RelayStatus.Kind.BROKEN, "broken", null},
            {HealthAnswer.Kind.TLS_FAILURE, "broken", null},
            {HealthAnswer.Kind.NOT_CEZAR, "broken", null},
            {HealthAnswer.Kind.LOCAL_MODE, "broken", null},
        };
        for (Object[] each : cases) {
            DeviceProbes.Reading reading = each[0] instanceof RelayStatus.Kind
                    ? DeviceProbes.Reading.of((RelayStatus.Kind) each[0]) : DeviceProbes.Reading.of((HealthAnswer.Kind) each[0]);
            Map<String, DeviceProbes.Reading> readings = new HashMap<>();
            readings.put("a", reading);
            CezarRows.Row row = rows(Collections.singletonList(relay("a", "box")), readings, new HashMap<>(), null).get(0);
            assertEquals(each[0].toString(), "other", row.status);
            assertEquals(each[0].toString(), each[1], row.reason);
            if (each[2] != null) assertEquals(each[2], row.words);
        }
    }

    @Test
    public void unreachableKindsAreOfflineWithNoReason() {
        for (RelayStatus.Kind kind : new RelayStatus.Kind[] {RelayStatus.Kind.RELAY_DOWN, RelayStatus.Kind.CEZAR_OFFLINE, RelayStatus.Kind.NOT_ANSWERING}) {
            Map<String, DeviceProbes.Reading> readings = new HashMap<>();
            readings.put("a", DeviceProbes.Reading.of(kind));
            CezarRows.Row row = rows(Collections.singletonList(relay("a", "box")), readings, new HashMap<>(), null).get(0);
            assertEquals(kind.name(), "offline", row.status);
            assertNull(kind.name(), row.reason);
        }
        assertNull(CezarRows.reason(HealthAnswer.Kind.UNREACHABLE.name()));
        assertNull(CezarRows.reason(HealthAnswer.Kind.CEZAR.name()));
    }

    @Test
    public void connectingStillReadsChecking() {
        Map<String, DeviceProbes.Reading> readings = new HashMap<>();
        readings.put("a", DeviceProbes.Reading.of(RelayStatus.Kind.CONNECTING));
        assertEquals("checking", rows(Collections.singletonList(relay("a", "box")), readings, new HashMap<>(), null).get(0).status);
    }

    @Test
    public void rowsComeInTheSwitchersOrder() {
        List<ServerRecord> servers = Arrays.asList(direct("off", "Off"), direct("blocked", "Blocked"), direct("on", "On"), direct("cur", "Cur"));
        Map<String, DeviceProbes.Reading> readings = new HashMap<>();
        readings.put("off", DeviceProbes.Reading.OFFLINE);
        readings.put("blocked", DeviceProbes.Reading.of(HealthAnswer.Kind.LOGIN_PAGE));
        readings.put("on", DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR));
        List<String> ids = new ArrayList<>();
        for (CezarRows.Row row : rows(servers, readings, new HashMap<>(), "cur")) ids.add(row.server.id);
        assertEquals(Arrays.asList("cur", "on", "off", "blocked"), ids);
    }

    @Test
    public void theCurrentCezarReadsOnlineUntilAProbeSaysOtherwise() {
        List<ServerRecord> servers = Collections.singletonList(direct("cur", "Cur"));
        assertEquals("online", rows(servers, new HashMap<>(), new HashMap<>(), "cur").get(0).status);
        Map<String, DeviceProbes.Reading> readings = new HashMap<>();
        readings.put("cur", DeviceProbes.Reading.CHECKING);
        assertEquals("online", rows(servers, readings, new HashMap<>(), "cur").get(0).status);
        // The page it came from is gone: a dead current cezar reads offline.
        readings.put("cur", DeviceProbes.Reading.OFFLINE);
        assertEquals("offline", rows(servers, readings, new HashMap<>(), "cur").get(0).status);
    }

    @Test
    public void notificationsPermissionWords() {
        assertEquals("allowed", CezarRows.notifications(true, true));
        assertEquals("unknown", CezarRows.notifications(false, true));
        assertEquals("denied", CezarRows.notifications(false, false));
    }

    @Test
    public void renameErrors() {
        ServerRecord server = direct("a", "box");
        assertEquals("This cezar is no longer on this phone.", CezarRows.renameError(null, "x"));
        assertEquals("Enter a name.", CezarRows.renameError(server, null));
        assertEquals("Enter a name.", CezarRows.renameError(server, "   "));
        assertNull(CezarRows.renameError(server, "  " + repeat("a", 60) + "  "));
        assertEquals("Use 60 characters or fewer.", CezarRows.renameError(server, repeat("a", 61)));
        // Characters, not UTF-16 units.
        assertNull(CezarRows.renameError(server, repeat("😀", 60)));
    }

    @Test
    public void renameTrimsAndSavesTheLabel() {
        ServerListStore servers = new ServerListStore(folder.getRoot());
        servers.put(relay("a", "old"));
        ShellConnector connector = new ShellConnector(servers, null, null);
        assertNull(connector.rename("a", "  Studio Mac  "));
        assertEquals("Studio Mac", servers.get("a").label);
        assertEquals("c-a", servers.get("a").relay.cezarId);
        assertEquals("Enter a name.", connector.rename("a", ""));
        assertEquals("Studio Mac", servers.get("a").label);
        assertEquals("This cezar is no longer on this phone.", connector.rename("gone", "x"));
    }

    private static String repeat(String text, int times) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < times; i++) out.append(text);
        return out.toString();
    }
}
