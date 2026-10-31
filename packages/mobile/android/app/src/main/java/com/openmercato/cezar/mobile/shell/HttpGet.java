package com.openmercato.cezar.mobile.shell;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** A GET that never follows a redirect and never pulls an unbounded body. */
public interface HttpGet {
    HttpAnswer get(String url, Map<String, String> headers) throws IOException;

    final class Platform implements HttpGet {
        private static final int TIMEOUT_MS = 10_000;
        private static final int MAX_BODY = 256 * 1024;
        private final boolean httpsOnly;

        public Platform() {
            this(true);
        }

        /** The test reaches a loopback plain-HTTP server; production has no caller of this. */
        Platform(boolean httpsOnly) {
            this.httpsOnly = httpsOnly;
        }

        @Override
        public HttpAnswer get(String url, Map<String, String> headers) throws IOException {
            if (httpsOnly && !url.startsWith("https://")) throw new IOException("https only");
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                for (Map.Entry<String, String> header : headers.entrySet()) {
                    connection.setRequestProperty(header.getKey(), header.getValue());
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                return new HttpAnswer(status, lowerCased(connection.getHeaderFields()), read(stream));
            } finally {
                connection.disconnect();
            }
        }

        private static Map<String, List<String>> lowerCased(Map<String, List<String>> fields) {
            Map<String, List<String>> out = new HashMap<>();
            for (Map.Entry<String, List<String>> field : fields.entrySet()) {
                if (field.getKey() != null) out.put(field.getKey().toLowerCase(Locale.ROOT), new ArrayList<>(field.getValue()));
            }
            return out;
        }

        private static String read(InputStream stream) throws IOException {
            if (stream == null) return "";
            try (InputStream in = stream) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while (out.size() < MAX_BODY && (count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }
}
