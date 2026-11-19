package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.HttpAnswer;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class CezarPushTest {
    @Test
    public void putSendsExactlyTheContractsThreeFields() throws Exception {
        FakeCezar cezar = new FakeCezar();
        CezarPush.State state = cezar.api().put(new PushGrant("sealed", GrantClientTest.GRANT_ID, 1_807_776_000L, GrantClientTest.CEZAR_KEY, false));
        assertEquals(GrantClientTest.GRANT_ID, state.grantId);
        JSONObject body = new JSONObject(cezar.bodies.get(0));
        assertEquals(3, body.length());
        assertEquals("sealed", body.getString("grant"));
        assertEquals(1_807_776_000L, body.getLong("expiresAt"));
        assertEquals("PUT /api/v1/workspace/phone/push", cezar.calls.get(0));
    }

    @Test
    public void a409MeansPushIsOffAtCezar() throws Exception {
        FakeCezar cezar = new FakeCezar();
        cezar.available = false;
        assertNull(cezar.api().put(new PushGrant("g", GrantClientTest.GRANT_ID, 1, GrantClientTest.CEZAR_KEY, false)));
        assertFalse(cezar.api().get().available);
    }

    @Test
    public void anOldCezarWithNoRouteReadsAsOff() throws Exception {
        CezarPush api = new CezarPush((method, path, headers, body) -> new HttpAnswer(404, Collections.<String, List<String>>emptyMap(), "{}"), "ua");
        assertFalse(api.get().available);
        api.delete();
    }

    @Test
    public void aKeyThatIsNotThirtyTwoBytesReadsAsOff() throws Exception {
        assertFalse(CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"short\"}").available);
        CezarPush.State ok = CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"" + GrantClientTest.CEZAR_KEY + "\",\"managerId\":\"m1\",\"extra\":1}");
        assertTrue(ok.available);
        assertEquals("m1", ok.managerId);
        assertNull(CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"" + GrantClientTest.CEZAR_KEY + "\",\"managerId\":7}").managerId);
    }
}
