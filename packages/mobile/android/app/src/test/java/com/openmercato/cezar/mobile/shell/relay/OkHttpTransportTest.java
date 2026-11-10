package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import org.junit.Test;

public class OkHttpTransportTest {
    private static final class Silent implements SocketTransport.Events {
        @Override public void opened() { }
        @Override public void text(String text) { }
        @Override public void binary(byte[] bytes) { }
        @Override public void closed(int code) { }
        @Override public void failed(int status, String code, long retryAfter, long date) { }
    }

    /** § 3: OkHttp offers permessage-deflate on its own unless the interceptor takes it off. */
    @Test
    public void theUpgradeOffersNoCompression() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(5000);
            new OkHttpTransport().connect("ws://127.0.0.1:" + server.getLocalPort() + "/v1/x", Collections.singletonMap("X-Test", "1"), new Silent());
            try (Socket socket = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
                StringBuilder head = new StringBuilder();
                for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine()) head.append(line.toLowerCase(Locale.ROOT)).append('\n');
                assertTrue(head.toString(), head.toString().contains("upgrade: websocket"));
                assertTrue(head.toString(), head.toString().contains("x-test: 1"));
                assertFalse(head.toString(), head.toString().contains("sec-websocket-extensions"));
            }
        }
    }
}
