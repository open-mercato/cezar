package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import org.junit.Test;

public class TunnelSessionTest {
    /** The nonce has moved by then, so any later frame would be undecryptable. */
    @Test
    public void aFrameTheSocketRefusesEndsTheSession() {
        boolean[] refuse = {false};
        NoiseHandshake.Keys keys = new NoiseHandshake.Keys(new NoiseCipher(RelayCrypto.random(32)), new NoiseCipher(RelayCrypto.random(32)));
        TunnelSession session = new TunnelSession(ciphertext -> {
            if (refuse[0]) throw new IOException("refused");
        }, keys, 65552, code -> { }, System::currentTimeMillis);
        assertTrue(session.live());
        refuse[0] = true;
        assertThrows(IOException.class, session::lease);
        assertFalse(session.live());
    }
}
