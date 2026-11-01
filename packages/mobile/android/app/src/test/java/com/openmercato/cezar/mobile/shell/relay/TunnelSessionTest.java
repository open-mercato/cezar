package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertEquals;
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

    /** 300 frames at once used to reach the socket in one second of the relay's 500, with cezar's replies on top. */
    @Test
    public void aBurstOfFramesIsPaced() throws IOException {
        long[] now = {1000};
        NoiseHandshake.Keys keys = new NoiseHandshake.Keys(new NoiseCipher(RelayCrypto.random(32)), new NoiseCipher(RelayCrypto.random(32)));
        FramePacer pacer = new FramePacer(500, () -> now[0], ms -> now[0] += ms);
        TunnelSession session = new TunnelSession(ciphertext -> { }, keys, 65552, pacer, code -> { }, () -> now[0]);
        for (int i = 0; i < 300; i++) session.lease();
        assertEquals(1000 + 299 * 5, now[0]);
    }

    @Test
    public void anIdleSessionDoesNotWait() throws IOException {
        long[] now = {1000};
        int[] sleeps = {0};
        NoiseHandshake.Keys keys = new NoiseHandshake.Keys(new NoiseCipher(RelayCrypto.random(32)), new NoiseCipher(RelayCrypto.random(32)));
        FramePacer pacer = new FramePacer(500, () -> now[0], ms -> sleeps[0]++);
        TunnelSession session = new TunnelSession(ciphertext -> { }, keys, 65552, pacer, code -> { }, () -> now[0]);
        for (int i = 0; i < 3; i++) {
            session.lease();
            now[0] += 20000;
        }
        assertEquals(0, sleeps[0]);
    }
}
