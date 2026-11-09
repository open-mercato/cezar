package com.openmercato.cezar.mobile.shell.push;

import java.util.HashMap;
import java.util.Map;

/** Which servers' pages are on screen. A signal for one of them shows nothing: the user is looking at it (spec R5, Stage 1). */
public final class ForegroundServers {
    public static final ForegroundServers SHARED = new ForegroundServers();

    private final Map<String, Integer> started = new HashMap<>();

    public synchronized void started(String serverId) {
        if (serverId == null) return;
        Integer count = started.get(serverId);
        started.put(serverId, count == null ? 1 : count + 1);
    }

    public synchronized void stopped(String serverId) {
        Integer count = serverId == null ? null : started.get(serverId);
        if (count == null) return;
        if (count <= 1) started.remove(serverId);
        else started.put(serverId, count - 1);
    }

    /** Whether a signal for this server raises a notification. */
    public synchronized boolean shouldNotify(String serverId) {
        return serverId != null && !started.containsKey(serverId);
    }
}
