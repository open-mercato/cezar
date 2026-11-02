package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** One row per line of the "In the shell" table. */
public class StartDecisionTest {
    private static HealthAnswer cezar(Boolean managers) {
        return new HealthAnswer(HealthAnswer.Kind.CEZAR, 200, null, "1", managers);
    }

    private static HealthAnswer kind(HealthAnswer.Kind kind) {
        return HealthAnswer.of(kind, 0);
    }

    @Test
    public void managersTrueOpensManager() {
        assertEquals(StartDecision.Route.MANAGER, StartDecision.decide(cezar(true), true));
        assertEquals("/manager", StartDecision.path(StartDecision.Route.MANAGER));
    }

    @Test
    public void managersFalseAndAbsentOpenRootWithDifferentNotes() {
        assertEquals(StartDecision.Route.ROOT_MANAGERS_OFF, StartDecision.decide(cezar(false), true));
        assertEquals(StartDecision.Route.ROOT_OLD_SERVER, StartDecision.decide(cezar(null), true));
        assertEquals("/", StartDecision.path(StartDecision.Route.ROOT_OLD_SERVER));
    }

    @Test
    public void probe401DependsOnASavedPassword() {
        assertEquals(StartDecision.Route.PASSWORD_REJECTED, StartDecision.decide(kind(HealthAnswer.Kind.BASIC_GATE), true));
        assertEquals(StartDecision.Route.ASK_CREDENTIALS, StartDecision.decide(kind(HealthAnswer.Kind.BASIC_GATE), false));
    }

    @Test
    public void probe403And302() {
        assertEquals(StartDecision.Route.LOCAL_MODE, StartDecision.decide(kind(HealthAnswer.Kind.LOCAL_MODE), true));
        assertEquals(StartDecision.Route.ROOT_LOGIN, StartDecision.decide(kind(HealthAnswer.Kind.LOGIN_PAGE), true));
        assertEquals("/", StartDecision.path(StartDecision.Route.ROOT_LOGIN));
    }

    @Test
    public void everythingElseIsTheConnectionError() {
        assertEquals(StartDecision.Route.CONNECTION_ERROR, StartDecision.decide(kind(HealthAnswer.Kind.UNREACHABLE), true));
        assertEquals(StartDecision.Route.CONNECTION_ERROR, StartDecision.decide(kind(HealthAnswer.Kind.NOT_CEZAR), true));
        assertEquals(StartDecision.Route.CONNECTION_ERROR, StartDecision.decide(kind(HealthAnswer.Kind.TLS_FAILURE), true));
    }
}
