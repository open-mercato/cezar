package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.util.Date;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.ConnectionPool;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/** OkHttp's WebSocket client. Cleartext goes through the platform's network security config, so a release build refuses it twice. */
public final class OkHttpTransport implements SocketTransport {
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            // A refused upgrade leaves its connection pooled, and the next socket would fail on it once it goes stale.
            .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
            // OkHttp always offers permessage-deflate, and § 3 forbids it. WebSocket calls skip network interceptors.
            .addInterceptor(chain -> chain.proceed(chain.request().newBuilder().removeHeader("Sec-WebSocket-Extensions").build()))
            .build();

    @Override
    public Connection connect(String url, Map<String, String> headers, Events events) {
        Request.Builder request = new Request.Builder().url(url.replaceFirst("^ws", "http"));
        for (Map.Entry<String, String> header : headers.entrySet()) request.header(header.getKey(), header.getValue());
        WebSocket socket = client.newWebSocket(request.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                events.opened();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                events.text(text);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                events.binary(bytes.toByteArray());
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
                events.closed(code);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
                if (response == null) {
                    events.failed(0, null, -1, -1);
                    return;
                }
                events.failed(response.code(), codeOf(response), retryAfter(response), date(response));
            }
        });
        return new Connection() {
            @Override
            public boolean sendText(String text) {
                return socket.send(text);
            }

            @Override
            public boolean sendBinary(byte[] bytes) {
                return socket.send(ByteString.of(bytes));
            }

            @Override
            public void close(int code) {
                if (!socket.close(code, null)) socket.cancel();
            }
        };
    }

    private static String codeOf(Response response) {
        try {
            return new JSONObject(response.peekBody(4096).string()).optString("code", null);
        } catch (IOException | org.json.JSONException e) {
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
