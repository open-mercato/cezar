package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.function.LongSupplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * One grant per relay server with its switch on: got on server open, handed to cezar, renewed, and
 * revoked at the relay when the switch goes off or the server is forgotten (spec R5 as built, § 7).
 * Logs statuses only, never a grant or a token.
 */
public final class PushCoordinator {
    private static final Logger LOG = Logger.getLogger("cezar.push");
    private static final long MAX_JITTER_MS = 300_000;

    /** The device keys a server proves with. The relay client owns them; a revoke may outlive the server. */
    public interface Keys {
        DeviceKeys get(String serverId);

        void delete(String serverId);
    }

    private final PushStore store;
    private final TokenSource tokens;
    private final GrantClient grants;
    private final Keys keys;
    private final LongSupplier clock;
    private final Random random;

    public PushCoordinator(PushStore store, TokenSource tokens, GrantClient grants, Keys keys, LongSupplier clock, Random random) {
        this.store = store;
        this.tokens = tokens;
        this.grants = grants;
        this.keys = keys;
        this.clock = clock;
        this.random = random;
    }

    /**
     * FCM, for Stage 2 (app closed or asleep). False in a build with no `google-services.json`: no grant
     * and no request. The switch works either way, since Stage 1 needs only the session.
     */
    public boolean available() {
        return tokens.available();
    }

    public boolean enabled(String serverId) {
        return store.server(serverId).enabled;
    }

    /** The first relay pairing asks once whether to turn notifications on, Firebase or not. */
    public boolean shouldAsk() {
        return !store.asked();
    }

    public void markAsked() {
        store.setAsked();
    }

    /**
     * The Servers list's switch, on any relay server. On is only saved: the signal stream and, with FCM,
     * the grant come with the next session (`sync`). Off revokes at the relay at once, and leaves cezar
     * its `DELETE` for the next session.
     */
    public synchronized boolean setEnabled(ServerRecord server, boolean on) {
        if (server == null || server.relay == null) return false;
        PushStore.Server current = store.server(server.id);
        if (on) {
            store.putServer(server.id, new PushStore.Server(true, current.held, current.grant));
            return true;
        }
        store.putServer(server.id, new PushStore.Server(false, current.held, null));
        if (current.grant != null) queueRevoke(server, current.grant, false);
        retryRevokes();
        return true;
    }

    /** A session to this server is up. Settles owed revokes, then makes cezar hold this phone's current grant, or none. */
    public synchronized void sync(ServerRecord server, CezarPush cezar) {
        if (server == null || server.relay == null) return;
        retryRevokes();
        PushStore.Server current = store.server(server.id);
        try {
            if (!current.enabled) {
                if (current.held) {
                    cezar.delete();
                    store.putServer(server.id, new PushStore.Server(false, false, null));
                }
                return;
            }
            if (!available()) return;
            CezarPush.State state = cezar.get();
            if (!state.available) {
                drop(server, current);
                return;
            }
            PushGrant grant = current.grant;
            switch (RenewalPolicy.decide(grant, state, clock.getAsLong() / 1000)) {
                case NONE:
                    if (!grant.handedOver) store.putServer(server.id, new PushStore.Server(true, true, grant.handedOver()));
                    return;
                case OBTAIN:
                    grant = obtain(server, state.cezarKey);
                    if (grant == null) return;
                    break;
                default:
                    break;
            }
            handOver(server, cezar, grant);
        } catch (IOException e) {
            LOG.log(Level.INFO, "push sync: " + e.getMessage());
        }
    }

    /** FCM rotated the token: each server with its switch on gets a grant for the new one, handed over on its next open. */
    public synchronized void onNewToken(List<ServerRecord> servers) {
        if (!available()) return;
        for (ServerRecord server : servers) {
            if (server.relay == null) continue;
            PushStore.Server current = store.server(server.id);
            // With no grant yet, cezar's key is unknown until the next open, which gets one anyway.
            if (current.enabled && current.grant != null) obtain(server, current.grant.cezarKey);
        }
    }

    /**
     * Forget server. The goodbye already made cezar deny its grants; the relay is told too. True while a
     * revoke is owed, when the caller must keep the device key: the revoke is signed with it.
     */
    public synchronized boolean forget(ServerRecord server) {
        if (server == null) return false;
        PushStore.Server current = store.server(server.id);
        store.removeServer(server.id);
        if (server.relay != null && current.grant != null) queueRevoke(server, current.grant, true);
        // A revoke the switch already owed now holds the device key too.
        List<PushStore.Revoke> marked = new ArrayList<>();
        for (PushStore.Revoke revoke : store.revokes()) {
            marked.add(revoke.serverId.equals(server.id)
                    ? new PushStore.Revoke(revoke.serverId, revoke.label, revoke.origin, revoke.grant, revoke.expiresAt, revoke.notBefore, revoke.attempts, true)
                    : revoke);
        }
        store.setRevokes(marked);
        retryRevokes();
        return owes(server.id);
    }

    /** Servers forgotten with a revoke still owed (§ 7). Unlocked: the list must not wait on a sync's network. */
    public List<String> removing() {
        List<String> labels = new ArrayList<>();
        for (PushStore.Revoke revoke : store.revokes()) {
            if (revoke.forgotten && !labels.contains(revoke.label)) labels.add(revoke.label);
        }
        return labels;
    }

    /** On app open and server open: each owed revoke that is due, until a terminal answer or its grant expires. */
    public synchronized void retryRevokes() {
        long now = clock.getAsLong();
        List<PushStore.Revoke> left = new ArrayList<>();
        List<String> settled = new ArrayList<>();
        for (PushStore.Revoke revoke : store.revokes()) {
            if (revoke.expiresAt * 1000 <= now) {
                settled.add(revoke.serverId);
                continue;
            }
            if (revoke.notBefore > now) {
                left.add(revoke);
                continue;
            }
            DeviceKeys deviceKeys = keys.get(revoke.serverId);
            if (deviceKeys == null) {
                // Nothing can sign it any more, so nothing more can be done.
                settled.add(revoke.serverId);
                continue;
            }
            GrantClient.RevokeAnswer answer = grants.revoke(revoke.origin, deviceKeys, revoke.grant);
            if (answer.outcome == GrantClient.Revoke.RETRY) {
                left.add(revoke.retryAt(now + delayMs(answer.retryAfter, revoke.attempts)));
            } else {
                if (answer.outcome == GrantClient.Revoke.STOPPED) LOG.info("push revoke stopped: " + answer.status);
                settled.add(revoke.serverId);
            }
        }
        store.setRevokes(left);
        for (String serverId : settled) {
            if (!owes(serverId) && forgottenServer(serverId)) keys.delete(serverId);
        }
    }

    private boolean owes(String serverId) {
        for (PushStore.Revoke revoke : store.revokes()) if (revoke.serverId.equals(serverId)) return true;
        return false;
    }

    /** A forgotten server has no push row left; one with its switch off keeps its row. */
    private boolean forgottenServer(String serverId) {
        return !store.serverIds().contains(serverId);
    }

    /** `Retry-After` when the relay sent one, else full jitter: 1 s to min(300 s, 2^n s) (§ 3.3). */
    private long delayMs(long retryAfter, int attempts) {
        if (retryAfter >= 0) return Math.max(1000, retryAfter * 1000);
        long cap = Math.min(MAX_JITTER_MS, 1000L << Math.min(attempts + 1, 20));
        return 1000 + (long) (random.nextDouble() * (cap - 1000));
    }

    private PushGrant obtain(ServerRecord server, String cezarKey) {
        DeviceKeys deviceKeys = keys.get(server.id);
        if (deviceKeys == null) return null;
        try {
            PushGrant grant = grants.obtain(server.relay.origin, deviceKeys, tokens.token(), cezarKey);
            PushStore.Server current = store.server(server.id);
            store.putServer(server.id, new PushStore.Server(current.enabled, current.held, grant));
            return grant;
        } catch (GrantClient.Failure e) {
            LOG.info("push grant: " + e.getMessage());
        } catch (IOException e) {
            LOG.info("push token: unavailable");
        }
        return null;
    }

    private void handOver(ServerRecord server, CezarPush cezar, PushGrant grant) throws IOException {
        CezarPush.State answer = cezar.put(grant);
        PushStore.Server current = store.server(server.id);
        if (answer == null) {
            drop(server, current);
            return;
        }
        store.putServer(server.id, new PushStore.Server(current.enabled, true, grant.handedOver()));
    }

    /** cezar has push off: the phone keeps no grant for it, and the relay denies the one it had. */
    private void drop(ServerRecord server, PushStore.Server current) {
        store.putServer(server.id, new PushStore.Server(current.enabled, false, null));
        if (current.grant != null) {
            queueRevoke(server, current.grant, false);
            retryRevokes();
        }
    }

    private void queueRevoke(ServerRecord server, PushGrant grant, boolean forgotten) {
        List<PushStore.Revoke> revokes = store.revokes();
        revokes.add(new PushStore.Revoke(server.id, server.label, server.relay.origin, grant.grant, grant.expiresAt, 0, 0, forgotten));
        store.setRevokes(revokes);
    }
}
