package com.openmercato.cezar.mobile.shell.push;

import java.io.IOException;
import java.util.Date;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONException;
import org.json.JSONObject;

/** OkHttp's `POST`. Cleartext goes through the platform's network security config, as for the socket. */
public final class OkHttpPushRelay implements PushRelay {
    private static final MediaType JSON = MediaType.get("application/json");
    private static final long MAX_BODY = 8192;

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            // A signed POST is never resent by the library: GrantClient decides what a retry is.
            .retryOnConnectionFailure(false)
            .build();

    @Override
    public Answer post(String url, Map<String, String> headers, byte[] body) throws IOException {
        Request.Builder request = new Request.Builder().url(url).post(RequestBody.create(body, JSON));
        for (Map.Entry<String, String> header : headers.entrySet()) request.header(header.getKey(), header.getValue());
        try (Response response = client.newCall(request.build()).execute()) {
            String text = read(response.body());
            return new Answer(response.code(), codeOf(text), retryAfter(response), date(response), text);
        }
    }

    private static String read(ResponseBody body) throws IOException {
        if (body == null) return "";
        return body.source().request(MAX_BODY) ? "" : body.string();
    }

    private static String codeOf(String text) {
        if (text.isEmpty()) return null;
        try {
            return new JSONObject(text).optString("code", null);
        } catch (JSONException e) {
            return null;
        }
    }

    private static long retryAfter(Response response) {
        String value = response.header("Retry-After");
        if (value == null || !value.matches("[0-9]{1,9}")) return -1;
        return Long.parseLong(value);
    }

    private static long date(Response response) {
        Date date = response.headers().getDate("Date");
        return date == null ? -1 : date.getTime();
    }
}
