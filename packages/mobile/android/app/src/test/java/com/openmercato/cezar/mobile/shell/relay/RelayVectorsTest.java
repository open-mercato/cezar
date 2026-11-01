package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Every file in test-vectors/relay, read in place so a copy cannot drift (RELAY_PROTOCOL.md § 17). */
public class RelayVectorsTest {
    private static JSONObject load(String name) throws Exception {
        String root = System.getProperty("relay.vectors");
        assertNotNull("relay.vectors is set by build.gradle", root);
        return new JSONObject(new String(Files.readAllBytes(new File(root, name).toPath()), StandardCharsets.UTF_8));
    }

    private static byte[] hex(String text) {
        byte[] out = new byte[text.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    private static List<JSONObject> list(JSONArray rows) throws Exception {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) out.add(rows.getJSONObject(i));
        return out;
    }

    private static void refuseRecord(byte[] record) {
        try {
            TunnelRecord.unpad(record);
            fail("record accepted");
        } catch (TunnelRecord.Malformed expected) {
            // refused
        }
    }

    @Test
    public void proofs() throws Exception {
        JSONObject file = load("proof.json");
        List<JSONObject> rows = list(file.getJSONArray("sockets"));
        assertEquals(3, rows.size());
        for (JSONObject row : rows) {
            byte[] seed = hex(row.getString("seed"));
            byte[] key = RelayCrypto.ed25519Public(seed);
            assertEquals(row.getString("name"), row.getString("key"), Bytes.base64url(key));
            assertEquals(row.getString("id"), RelayIds.id(key));
            String[] lines = row.getString("proofString").split("\n");
            assertEquals(row.getString("proofString"), RelayIds.socketProof(lines[1], lines[2], lines[3], row.getLong("time")));
            assertEquals(row.getString("sig"), RelayIds.sign(seed, row.getString("proofString")));
            assertTrue(RelayCrypto.ed25519Verify(key, Bytes.utf8(row.getString("proofString")), Bytes.fromBase64url(row.getString("sig"))));
        }
        for (JSONObject row : list(file.getJSONArray("posts"))) {
            byte[] seed = hex(row.getString("seed"));
            assertEquals(row.getString("proofString"), RelayIds.postProof(row.getString("path"), Bytes.utf8(row.getString("body")), row.getLong("time")));
            assertEquals(row.getString("sig"), RelayIds.sign(seed, row.getString("proofString")));
        }
    }

    @Test
    public void qrAcceptedAndDerived() throws Exception {
        JSONObject file = load("qr.json");
        for (JSONObject row : list(file.getJSONArray("accepted"))) {
            for (boolean debug : new boolean[] {false, true}) {
                boolean allowed = row.getBoolean(debug ? "debug" : "release");
                try {
                    PairSecret secret = PairSecret.fromQr(row.getString("qr"), debug);
                    assertTrue(row.getString("qr"), allowed);
                    assertEquals(row.getString("relayOrigin"), secret.relay.origin);
                    assertEquals(row.getString("socketOrigin"), secret.relay.socketOrigin);
                    assertEquals(file.getString("locator"), secret.locator());
                    assertEquals(file.getString("locatorHex"), hex(secret.locatorBytes));
                    assertEquals(file.getString("psk"), hex(secret.psk));
                    assertEquals(file.getString("cezarX25519"), hex(secret.pinnedKey));
                } catch (RelayOrigin.Refused refused) {
                    assertFalse(row.getString("qr"), allowed);
                    assertEquals("cleartext", refused.reason);
                }
            }
        }
    }

    @Test
    public void qrRefused() throws Exception {
        for (JSONObject row : list(load("qr.json").getJSONArray("refused"))) {
            for (boolean debug : new boolean[] {false, true}) {
                try {
                    PairSecret.fromQr(row.getString("qr"), debug);
                    fail(row.getString("name"));
                } catch (RelayOrigin.Refused refused) {
                    assertEquals(row.getString("name"), row.getString("reason"), refused.reason);
                }
            }
        }
    }

    @Test
    public void codes() throws Exception {
        JSONObject file = load("code.json");
        RelayOrigin relay = RelayOrigin.parse("https://relay.example.test", false);
        for (JSONObject row : list(file.getJSONArray("cases"))) {
            JSONArray inputs = row.getJSONArray("inputs");
            for (int i = 0; i < inputs.length(); i++) assertEquals(row.getString("code"), PairSecret.normalizeCode(inputs.getString(i).trim()));
            PairSecret secret = PairSecret.fromCode(row.getString("code"), relay);
            assertEquals(row.getString("locator"), secret.locator());
            assertEquals(row.getString("locatorHex"), hex(secret.locatorBytes));
            assertEquals(row.getString("psk"), hex(secret.psk));
            assertNull(secret.pinnedKey);
        }
        for (JSONObject row : list(file.getJSONArray("refused"))) assertNull(row.getString("name"), PairSecret.normalizeCode(row.getString("input")));
    }

    @Test
    public void digits() throws Exception {
        for (JSONObject row : list(load("sas.json").getJSONArray("cases"))) {
            assertEquals(row.getString("sas"), PairSecret.sasDigits(hex(row.getString("handshakeHash"))));
        }
    }

    @Test
    public void pairingHandshakeBothRoles() throws Exception {
        JSONObject file = load("handshake-xxpsk3.json");
        JSONObject phone = file.getJSONObject("phone");
        JSONObject cezar = file.getJSONObject("cezar");
        byte[] prologue = hex(file.getString("prologue"));
        byte[] psk = hex(file.getString("psk"));
        NoiseHandshake initiator = NoiseHandshake.forVector("XXpsk3", true, prologue, hex(phone.getString("x25519Secret")), null, psk, hex(phone.getString("ephemeralSecret")));
        NoiseHandshake responder = NoiseHandshake.forVector("XXpsk3", false, prologue, hex(cezar.getString("x25519Secret")), null, psk, hex(cezar.getString("ephemeralSecret")));
        for (JSONObject row : list(file.getJSONArray("messages"))) {
            boolean fromPhone = row.getString("from").equals("phone");
            byte[] payload = hex(row.getString("payload"));
            byte[] message = (fromPhone ? initiator : responder).writeMessage(payload);
            assertEquals(row.getString("message"), hex(message));
            assertEquals(row.getInt("bytes"), message.length);
            assertEquals(row.getString("frame"), "01" + hex(message));
            assertArrayEquals(payload, (fromPhone ? responder : initiator).readMessage(message));
        }
        assertEquals(file.getString("handshakeHash"), hex(initiator.handshakeHash()));
        assertEquals(file.getString("handshakeHash"), hex(responder.handshakeHash()));
        assertEquals(file.getString("sas"), PairSecret.sasDigits(initiator.handshakeHash()));
        assertEquals(cezar.getString("x25519Public"), hex(initiator.remoteStatic()));
        assertEquals(phone.getString("x25519Public"), hex(responder.remoteStatic()));
        NoiseHandshake.Keys phoneKeys = initiator.split();
        NoiseHandshake.Keys cezarKeys = responder.split();
        assertEquals(cezar.getString("cezarId"), RelayIds.id(RelayCrypto.ed25519Public(hex(cezar.getString("ed25519Seed")))));
        assertEquals(phone.getString("deviceId"), RelayIds.id(RelayCrypto.ed25519Public(hex(phone.getString("ed25519Seed")))));
        byte[] sealedBySplit = phoneKeys.send.encrypt(new byte[0]);
        assertArrayEquals(new NoiseCipher(hex(file.getJSONObject("transportKeys").getString("phoneToCezar"))).encrypt(new byte[0]), sealedBySplit);
        byte[] toPhone = hex(file.getJSONObject("transportKeys").getString("cezarToPhone"));
        JSONObject after = file.getJSONObject("afterHandshake");
        JSONObject pending = after.getJSONObject("pending");
        assertEquals(pending.getString("ciphertext"), hex(cezarKeys.send.encrypt(hex(pending.getString("record")))));
        assertEquals(pending.getString("text"), new String(TunnelRecord.unpad(phoneKeys.receive.decrypt(hex(pending.getString("ciphertext")))), StandardCharsets.UTF_8));
        for (JSONObject row : list(after.getJSONArray("outcomesAtNonce1"))) {
            byte[] sealed = hex(row.getString("ciphertext"));
            assertEquals(row.getString("ciphertext"), hex(new NoiseCipher(toPhone, row.getLong("nonce")).encrypt(hex(row.getString("record")))));
            assertEquals(row.getString("text"), new String(TunnelRecord.unpad(new NoiseCipher(toPhone, row.getLong("nonce")).decrypt(sealed)), StandardCharsets.UTF_8));
        }
    }

    @Test
    public void sessionTranscript() throws Exception {
        JSONObject file = load("session-kk.json");
        JSONObject phone = file.getJSONObject("phone");
        JSONObject cezar = file.getJSONObject("cezar");
        byte[] prologue = hex(file.getString("prologue"));
        assertEquals(hex(Bytes.concat(Bytes.ascii("cezar-session-v1"), Bytes.fromBase64url(file.getString("cezarId")), Bytes.fromBase64url(file.getString("deviceId")))), file.getString("prologue"));
        byte[] phoneSecret = hex(phone.getString("x25519Secret"));
        byte[] cezarSecret = hex(cezar.getString("x25519Secret"));
        NoiseHandshake initiator = NoiseHandshake.forVector("KK", true, prologue, phoneSecret, hex(cezar.getString("x25519Public")), null, hex(phone.getString("ephemeralSecret")));
        NoiseHandshake responder = NoiseHandshake.forVector("KK", false, prologue, cezarSecret, hex(phone.getString("x25519Public")), null, hex(cezar.getString("ephemeralSecret")));
        JSONObject first = file.getJSONObject("first");
        JSONObject second = file.getJSONObject("second");
        byte[] message = initiator.writeMessage(new byte[0]);
        assertEquals(first.getString("message"), hex(message));
        assertEquals(48, message.length);
        assertEquals(first.getString("phoneToRelay"), "01" + hex(message));
        assertEquals(0, responder.readMessage(message).length);
        byte[] reply = responder.writeMessage(hex(second.getString("payload")));
        assertEquals(second.getString("message"), hex(reply));
        assertEquals(second.getString("relayToPhone"), "01" + hex(reply));
        assertEquals(second.getString("payloadText"), new String(TunnelRecord.unpad(initiator.readMessage(reply)), StandardCharsets.UTF_8));
        assertEquals(file.getString("handshakeHash"), hex(initiator.handshakeHash()));
        NoiseHandshake.Keys phoneKeys = initiator.split();
        NoiseHandshake.Keys cezarKeys = responder.split();
        for (JSONObject row : list(file.getJSONArray("transcript"))) {
            boolean fromPhone = row.getString("from").equals("phone");
            byte[] record = hex(row.getString("record"));
            assertEquals(row.getString("content"), hex(TunnelRecord.unpad(record)));
            assertEquals(row.getString("name"), hex(TunnelRecord.pad(hex(row.getString("content")))), row.getString("record"));
            assertEquals(row.getLong("nonce"), (fromPhone ? phoneKeys.send : cezarKeys.send).nonce());
            byte[] sealed = (fromPhone ? phoneKeys.send : cezarKeys.send).encrypt(record);
            assertEquals(row.getString("ciphertext"), hex(sealed));
            assertArrayEquals(record, (fromPhone ? cezarKeys.receive : phoneKeys.receive).decrypt(sealed));
            TunnelFrame.parse(hex(row.getString("content")));
        }
    }

    @Test
    public void frames() throws Exception {
        JSONObject file = load("frames.json");
        assertEquals(file.getString("deviceId"), Bytes.base64url(hex(file.getString("deviceIdHex"))));
        assertEquals(file.getJSONObject("data").getString("phoneToRelay"), hex(Bytes.concat(new byte[] {1}, hex(file.getString("ciphertext")))));
    }

    @Test
    public void tunnelFrames() throws Exception {
        JSONObject file = load("tunnel-frames.json");
        for (JSONObject row : list(file.getJSONArray("frames"))) {
            byte[] content = hex(row.getString("content"));
            JSONObject fields = row.getJSONObject("fields");
            TunnelFrame frame = TunnelFrame.parse(content);
            assertEquals(row.getString("record"), hex(TunnelRecord.pad(content)));
            byte[] rebuilt = rebuild(frame, fields);
            assertEquals(row.getString("name"), row.getString("content"), hex(rebuilt));
        }
        for (JSONObject row : list(file.getJSONArray("padding"))) {
            byte[] content = new byte[row.getInt("contentLength")];
            Arrays.fill(content, (byte) 0xab);
            byte[] record = TunnelRecord.pad(content);
            assertEquals(row.getInt("recordLength"), record.length);
            assertEquals(row.getString("recordSha256"), hex(RelayCrypto.sha256(record)));
        }
        for (JSONObject row : list(file.getJSONArray("limits"))) {
            int frameBytes = row.getInt("frameBytes");
            assertEquals(row.getInt("maxCiphertext"), TunnelRecord.maxCiphertext(frameBytes));
            assertEquals(row.getInt("maxRecord"), TunnelRecord.maxRecord(frameBytes));
            assertEquals(row.getInt("maxContent"), TunnelRecord.maxContent(frameBytes));
            assertEquals(row.getInt("maxData"), TunnelRecord.maxData(frameBytes));
        }
        JSONObject chunking = file.getJSONObject("chunking");
        JSONArray chunks = chunking.getJSONArray("chunks");
        int left = chunking.getInt("bodyBytes");
        int max = TunnelRecord.maxData(chunking.getInt("frameBytes"));
        for (int i = 0; i < chunks.length(); i++) {
            int chunk = Math.min(left, max);
            assertEquals(chunks.getInt(i), chunk);
            left -= chunk;
        }
        assertEquals(0, left);
    }

    private static byte[] rebuild(TunnelFrame frame, JSONObject fields) throws Exception {
        List<TunnelFrame.Header> headers = new ArrayList<>();
        JSONArray rows = fields.optJSONArray("headers");
        for (int i = 0; rows != null && i < rows.length(); i++) headers.add(new TunnelFrame.Header(rows.getJSONArray(i).getString(0), rows.getJSONArray(i).getString(1)));
        switch (frame.type) {
            case TunnelFrame.HELLO:
                return TunnelFrame.hello(fields.getInt("min"), fields.getInt("max"));
            case TunnelFrame.OPEN:
                return TunnelFrame.open(fields.getInt("stream"), fields.getString("method"), fields.getString("target"), headers);
            case TunnelFrame.HEAD:
                return TunnelFrame.head(fields.getInt("stream"), fields.getInt("status"), headers);
            case TunnelFrame.DATA:
                byte[] data = hex(fields.getString("data"));
                return TunnelFrame.data(fields.getInt("stream"), data, 0, data.length);
            case TunnelFrame.END:
                return TunnelFrame.end(fields.getInt("stream"));
            case TunnelFrame.RESET:
                return TunnelFrame.reset(fields.getInt("stream"), fields.getInt("code"));
            case TunnelFrame.WINDOW:
                return TunnelFrame.window(fields.getInt("stream"), fields.getInt("increment"));
            case TunnelFrame.LEASE:
                return TunnelFrame.lease();
            case TunnelFrame.REKEY:
                return TunnelFrame.rekey();
            default:
                return TunnelFrame.close(fields.getInt("code"));
        }
    }

    @Test
    public void rekey() throws Exception {
        JSONObject file = load("rekey.json");
        NoiseCipher send = null;
        String key = null;
        for (JSONObject row : list(file.getJSONArray("steps"))) {
            if (send == null) {
                key = row.getString("key");
                send = new NoiseCipher(hex(key));
            } else if (!key.equals(row.getString("key"))) {
                send.rekey();
                key = row.getString("key");
            }
            assertEquals(row.getString("name"), row.getLong("nonce"), send.nonce());
            byte[] sealed = send.encrypt(hex(row.getString("record")));
            assertEquals(row.getString("name"), row.getString("ciphertext"), hex(sealed));
        }
        JSONObject other = file.getJSONObject("otherDirection");
        assertEquals(other.getString("ciphertext"), hex(new NoiseCipher(hex(other.getString("key")), other.getLong("nonce")).encrypt(hex(other.getString("record")))));
    }

    @Test
    public void negativeTransport() throws Exception {
        JSONObject file = load("negative.json");
        for (JSONObject row : list(file.getJSONArray("transport"))) {
            NoiseCipher receive = new NoiseCipher(hex(row.getString("key")));
            boolean failed = false;
            for (JSONObject step : list(row.getJSONArray("deliver"))) {
                try {
                    receive.decrypt(hex(step.getString("ciphertext")));
                    assertNotEquals(row.getString("name"), "fail", step.getString("expect"));
                } catch (RelayCrypto.DecryptFailure e) {
                    assertEquals(row.getString("name"), "fail", step.getString("expect"));
                    failed = true;
                    break;
                }
            }
            assertTrue(row.getString("name"), failed);
        }
        JSONObject after = file.getJSONObject("afterRekey");
        NoiseCipher receive = new NoiseCipher(hex(after.getString("key")), after.getLong("nonce"));
        try {
            receive.decrypt(hex(after.getString("ciphertext")));
            fail(after.getString("name"));
        } catch (RelayCrypto.DecryptFailure expected) {
            // refused
        }
    }

    private static void assertNotEquals(String name, String unexpected, String actual) {
        assertFalse(name, unexpected.equals(actual));
    }

    @Test
    public void negativeHandshakes() throws Exception {
        JSONObject file = load("negative.json");
        JSONObject pair = load("handshake-xxpsk3.json");
        JSONObject session = load("session-kk.json");
        for (JSONObject row : list(file.getJSONArray("handshake"))) {
            String name = row.getString("name");
            if (row.has("pinned")) {
                assertFalse(name, org.bouncycastle.util.Arrays.constantTimeAreEqual(hex(row.getString("pinned")), hex(row.getString("receivedStatic"))));
            } else if (row.getString("pattern").equals("KK")) {
                byte[] message = hex(row.getString("message"));
                NoiseHandshake responder = NoiseHandshake.forVector("KK", false, hex(session.getString("prologue")), hex(session.getJSONObject("cezar").getString("x25519Secret")),
                        hex(session.getJSONObject("phone").getString("x25519Public")), null, hex(session.getJSONObject("cezar").getString("ephemeralSecret")));
                boolean refused = message.length != 48;
                if (!refused) {
                    try {
                        responder.readMessage(message);
                    } catch (RelayCrypto.DecryptFailure e) {
                        refused = true;
                    }
                }
                assertTrue(name, refused);
            } else {
                JSONObject cezar = pair.getJSONObject("cezar");
                NoiseHandshake responder = NoiseHandshake.forVector("XXpsk3", false, hex(pair.getString("prologue")), hex(cezar.getString("x25519Secret")), null,
                        hex(pair.getString("psk")), hex(cezar.getString("ephemeralSecret")));
                JSONArray before = row.getJSONArray("messagesBefore");
                for (int i = 0; i < before.length(); i++) responder.readMessage(hex(before.getString(i)));
                responder.writeMessage(new byte[0]);
                try {
                    responder.readMessage(hex(row.getString("message")));
                    fail(name);
                } catch (RelayCrypto.DecryptFailure expected) {
                    // psk3 fails decryption
                }
            }
        }
    }

    @Test
    public void negativeRecordsAndFrames() throws Exception {
        JSONObject file = load("negative.json");
        for (JSONObject row : list(file.getJSONArray("record"))) refuseRecord(hex(row.getString("record")));
        for (JSONObject row : list(file.getJSONArray("tunnel"))) {
            try {
                TunnelFrame.parse(hex(row.getString("content")));
                fail(row.getString("name"));
            } catch (TunnelRecord.Malformed expected) {
                // refused
            }
        }
    }

    @Test
    public void publishedNoiseVectors() throws Exception {
        List<JSONObject> rows = list(load("noise-published/vectors.json").getJSONArray("vectors"));
        assertEquals(5, rows.size());
        assertTrue(rows.stream().anyMatch(row -> row.optString("protocol_name").contains("XXpsk3")));
        for (JSONObject row : rows) {
            String pattern = row.getString("protocol_name").split("_")[1];
            byte[] prologue = hex(row.getString("init_prologue"));
            byte[] psk = row.has("init_psks") && row.getJSONArray("init_psks").length() > 0 ? hex(row.getJSONArray("init_psks").getString(0)) : null;
            NoiseHandshake initiator = NoiseHandshake.forVector(pattern, true, prologue, hex(row.getString("init_static")), hexOrNull(row, "init_remote_static"), psk, hex(row.getString("init_ephemeral")));
            NoiseHandshake responder = NoiseHandshake.forVector(pattern, false, prologue, hex(row.getString("resp_static")), hexOrNull(row, "resp_remote_static"), psk, hex(row.getString("resp_ephemeral")));
            List<JSONObject> messages = list(row.getJSONArray("messages"));
            int handshakeMessages = pattern.equals("KK") ? 2 : 3;
            NoiseHandshake.Keys initiatorKeys = null;
            NoiseHandshake.Keys responderKeys = null;
            for (int i = 0; i < messages.size(); i++) {
                JSONObject message = messages.get(i);
                byte[] payload = hex(message.getString("payload"));
                boolean fromInitiator = i % 2 == 0;
                byte[] wire;
                if (i < handshakeMessages) {
                    wire = (fromInitiator ? initiator : responder).writeMessage(payload);
                    assertArrayEquals((fromInitiator ? responder : initiator).readMessage(wire), payload);
                    if (i == handshakeMessages - 1) {
                        initiatorKeys = initiator.split();
                        responderKeys = responder.split();
                        if (row.has("handshake_hash")) assertEquals(row.getString("handshake_hash"), hex(initiator.handshakeHash()));
                    }
                } else {
                    wire = (fromInitiator ? initiatorKeys.send : responderKeys.send).encrypt(payload);
                    assertArrayEquals((fromInitiator ? responderKeys.receive : initiatorKeys.receive).decrypt(wire), payload);
                }
                assertEquals(row.getString("protocol_name") + " message " + i, message.getString("ciphertext"), hex(wire));
            }
        }
    }

    private static byte[] hexOrNull(JSONObject row, String key) throws Exception {
        return row.has(key) ? hex(row.getString(key)) : null;
    }

    @Test
    public void strictBase64url() {
        assertNull(Bytes.fromBase64url("YQ=="));
        assertNull(Bytes.fromBase64url("Y+/a"));
        assertNull(Bytes.fromBase64url("YR"));
        assertArrayEquals(new byte[] {'a'}, Bytes.fromBase64url("YQ"));
        assertNull(Bytes.fromBase64url("YQ", 2));
        assertEquals(Arrays.asList("YQ"), Arrays.asList(Bytes.base64url(new byte[] {'a'})));
    }
}
