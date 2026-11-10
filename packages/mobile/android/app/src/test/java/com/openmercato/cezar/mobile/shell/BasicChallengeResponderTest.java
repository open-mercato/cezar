package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class BasicChallengeResponderTest {
    private static final String PAGE = "https://cezar.example.com/manager";
    private final AtomicInteger reads = new AtomicInteger();
    private final ServerRecord server = new ServerRecord("id", "box", "https://cezar.example.com", "me", "cezar", null);
    private final BasicChallengeResponder responder = new BasicChallengeResponder(server, id -> {
        reads.incrementAndGet();
        return "secret";
    });

    @Test
    public void answersItsOwnServer() {
        BasicChallengeResponder.Reply reply = responder.onChallenge("cezar.example.com", "cezar", PAGE, false);
        assertEquals(BasicChallengeResponder.Kind.ANSWER, reply.kind);
        assertEquals("me", reply.username);
        assertEquals("secret", reply.password);
    }

    @Test
    public void cancelsAForeignHostAndNeverReadsThePassword() {
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, responder.onChallenge("evil.example.com", "cezar", PAGE, false).kind);
        assertEquals(0, reads.get());
    }

    @Test
    public void cancelsAnotherRealm() {
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, responder.onChallenge("cezar.example.com", "other", PAGE, false).kind);
    }

    @Test
    public void cancelsWhenThePageIsOnAnotherPortOrScheme() {
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, responder.onChallenge("cezar.example.com", "cezar", "https://cezar.example.com:8443/", false).kind);
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, responder.onChallenge("cezar.example.com", "cezar", "http://cezar.example.com/", false).kind);
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, responder.onChallenge("cezar.example.com", "cezar", null, false).kind);
        assertEquals(0, reads.get());
    }

    @Test
    public void aServerSavedWithoutARealmIsNeverAnswered() {
        ServerRecord open = new ServerRecord("id", "box", "https://cezar.example.com", null, null, null);
        BasicChallengeResponder none = new BasicChallengeResponder(open, id -> "secret");
        assertEquals(BasicChallengeResponder.Kind.CANCEL_FOREIGN, none.onChallenge("cezar.example.com", "cezar", PAGE, false).kind);
    }

    @Test
    public void doesNotRetryARejectedPassword() {
        assertEquals(BasicChallengeResponder.Kind.CANCEL_REJECTED, responder.onChallenge("cezar.example.com", "cezar", PAGE, true).kind);
        assertEquals(0, reads.get());
    }

    @Test
    public void aSecondChallengeGetsNoPassword() {
        responder.onChallenge("cezar.example.com", "cezar", PAGE, false);
        assertEquals(BasicChallengeResponder.Kind.CANCEL_VERIFY, responder.onChallenge("cezar.example.com", "cezar", PAGE, false).kind);
        assertEquals(1, reads.get());
    }

    @Test
    public void aChallengeAfterTheStartPageGetsNoPassword() {
        responder.onStartPageLoaded();
        assertEquals(BasicChallengeResponder.Kind.CANCEL_VERIFY, responder.onChallenge("cezar.example.com", "cezar", PAGE, false).kind);
        assertEquals(0, reads.get());
    }

    @Test
    public void aFailedAttemptIsARejectionEvenWhenDisarmed() {
        responder.onChallenge("cezar.example.com", "cezar", PAGE, false);
        assertEquals(BasicChallengeResponder.Kind.CANCEL_REJECTED, responder.onChallenge("cezar.example.com", "cezar", PAGE, true).kind);
    }

    @Test
    public void aMissingPasswordIsARejection() {
        BasicChallengeResponder empty = new BasicChallengeResponder(server, id -> null);
        assertEquals(BasicChallengeResponder.Kind.CANCEL_REJECTED, empty.onChallenge("cezar.example.com", "cezar", PAGE, false).kind);
    }
}
