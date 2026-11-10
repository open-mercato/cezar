package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class RenewalPolicyTest {
    private static final long NOW = 1_800_000_000L;
    private static final long DAY = 24 * 60 * 60;
    private static final String KEY = GrantClientTest.CEZAR_KEY;
    private static final String ID = GrantClientTest.GRANT_ID;

    private static CezarPush.State cezar(String grantId) {
        return new CezarPush.State(true, KEY, grantId, 0, null);
    }

    private static PushGrant grant(long daysLeft, boolean handedOver) {
        return new PushGrant("sealed", ID, NOW + daysLeft * DAY, KEY, handedOver);
    }

    @Test
    public void noGrantGetsOne() {
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(null, cezar(null), NOW));
    }

    @Test
    public void cezarHoldingTheCurrentGrantNeedsNothing() {
        assertEquals(RenewalPolicy.Action.NONE, RenewalPolicy.decide(grant(60, true), cezar(ID), NOW));
        assertEquals(RenewalPolicy.Action.NONE, RenewalPolicy.decide(grant(30, true), cezar(ID), NOW));
    }

    @Test
    public void underThirtyDaysLeftRenews() {
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(grant(29, true), cezar(ID), NOW));
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(grant(-1, true), cezar(ID), NOW));
    }

    @Test
    public void cezarHoldingNoneOrAnotherRenews() {
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(grant(60, true), cezar(null), NOW));
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(grant(60, true), cezar("BBBBBBBBBBBBBBBBBBBBBB"), NOW));
    }

    @Test
    public void aGrantCezarNeverHadIsHandedOverNotReplaced() {
        assertEquals(RenewalPolicy.Action.HAND_OVER, RenewalPolicy.decide(grant(60, false), cezar(null), NOW));
        assertEquals(RenewalPolicy.Action.HAND_OVER, RenewalPolicy.decide(grant(60, false), cezar("BBBBBBBBBBBBBBBBBBBBBB"), NOW));
    }

    @Test
    public void aGrantForAnotherCezarKeyRenews() {
        PushGrant other = new PushGrant("sealed", ID, NOW + 60 * DAY, "other", true);
        assertEquals(RenewalPolicy.Action.OBTAIN, RenewalPolicy.decide(other, cezar(ID), NOW));
    }
}
