package com.openmercato.cezar.mobile.shell.relay;

/**
 * What a move of the default network means for the relay socket (iOS NetworkChange). The socket is bound to
 * the network it was dialed on: another default network, or one back from none, means that socket is dead.
 */
public final class NetworkChange {
    private boolean seen;
    private Long current;

    /** No default network now; false until the first callback says so. */
    public synchronized boolean offline() {
        return seen && current == null;
    }

    /** The default network is now `handle`, or none for null. The first call only says where the watch started. */
    public synchronized RelayLink.NetworkAction moved(Long handle) {
        boolean first = !seen;
        seen = true;
        Long before = current;
        current = handle;
        if (first || handle == null) return RelayLink.NetworkAction.NONE;
        if (before == null) return RelayLink.NetworkAction.RECONNECT;
        return before.equals(handle) ? RelayLink.NetworkAction.NONE : RelayLink.NetworkAction.RECONNECT;
    }
}
