package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.List;
import java.util.regex.Pattern;

/** A tapped notification carries only `s`, the cezarId (§ 7). The manager comes from cezar, inside the session. */
public final class PushTap {
    public static final String EXTRA = "s";
    private static final Pattern CEZAR_ID = Pattern.compile("[A-Za-z0-9_-]{22}");
    private static final Pattern MANAGER_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    /** cezar's answer to `GET /workspace/phone/push` inside the session the open just made, or null. */
    public interface ManagerLookup {
        String managerId(ServerRecord server);
    }

    private static String pending;

    private PushTap() {}

    /** A launch intent's `s`, kept for the connect page's next launch. Anything malformed is dropped. */
    public static synchronized void offer(String cezarId) {
        if (cezarId != null && CEZAR_ID.matcher(cezarId).matches()) pending = cezarId;
    }

    public static synchronized String take() {
        String value = pending;
        pending = null;
        return value;
    }

    /** The saved relay server for this cezarId, or null: an unknown one gets the normal start. */
    public static ServerRecord serverFor(String cezarId, List<ServerRecord> servers) {
        if (cezarId == null || !CEZAR_ID.matcher(cezarId).matches()) return null;
        for (ServerRecord server : servers) {
            if (server.relay != null && cezarId.equals(server.relay.cezarId)) return server;
        }
        return null;
    }

    /**
     * Opens the tapped server through the normal open, so the app lock and the start table still apply.
     * Null for an unknown cezarId: the caller starts as usual. Nothing is ever approved from here.
     */
    public static ShellConnector.Outcome open(ShellConnector connector, String cezarId, ManagerLookup lookup) {
        ServerRecord server = serverFor(cezarId, connector.list());
        if (server == null) return null;
        ShellConnector.Outcome outcome = connector.open(server.id, null);
        if (!ShellConnector.OPEN.equals(outcome.screen) || !"/manager".equals(outcome.url)) return outcome;
        return ShellConnector.withUrl(outcome, landing(outcome.url, lookup.managerId(server)));
    }

    public static boolean validManagerId(String managerId) {
        return managerId != null && MANAGER_ID.matcher(managerId).matches();
    }

    /** Where the server view lands: the manager the push was about, when the start route is the manager at all. */
    public static String landing(String startPath, String managerId) {
        if (!"/manager".equals(startPath) || !validManagerId(managerId)) return startPath;
        try {
            return "/manager/" + URLEncoder.encode(managerId, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return startPath;
        }
    }
}
