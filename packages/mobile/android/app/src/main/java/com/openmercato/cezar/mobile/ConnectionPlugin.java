package com.openmercato.cezar.mobile;

import android.content.Intent;
import android.webkit.CookieManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.openmercato.cezar.mobile.shell.OriginGate;
import com.openmercato.cezar.mobile.shell.ServerActivity;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellRoute;
import com.openmercato.cezar.mobile.shell.ShellServices;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/** Framework adapter for the connect page. All decisions live in the plain shell package. */
@CapacitorPlugin(name = "Connection")
public class ConnectionPlugin extends Plugin {
    private final ExecutorService background = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void launch(PluginCall call) {
        ShellRoute route = ShellRoute.take();
        if (route != null) {
            run(call, connector -> {
                JSObject result = list(connector);
                result.put("screen", route.screen);
                result.put("serverId", route.serverId);
                return result;
            });
            return;
        }
        run(call, connector -> {
            if (ServerActivity.isOpen()) {
                JSObject result = list(connector);
                result.put("screen", ShellConnector.OPEN);
                return result;
            }
            return present(connector.launch(cookiesForLast(connector)), connector, null);
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        run(call, connector -> {
            ServerRecord server = connector.server(id);
            return present(connector.open(id, server == null ? null : cookies(server.url)), connector, null);
        });
    }

    @PluginMethod
    public void add(PluginCall call) {
        String url = call.getString("url");
        String username = call.getString("username");
        String password = call.getString("password");
        String label = call.getString("label");
        run(call, connector -> present(connector.add(url, username, password, label), connector, label));
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String id = call.getString("id");
        run(call, connector -> {
            ServerRecord server = connector.server(id);
            connector.forget(id);
            if (server != null) getActivity().runOnUiThread(() -> clearWebsiteData(server.url));
            return list(connector);
        });
    }

    /** Refuses before any work: WebView.getUrl is main-thread only, the work is not. */
    private void run(PluginCall call, Function<ShellConnector, JSObject> work) {
        getActivity().runOnUiThread(() -> {
            if (!OriginGate.allows(getBridge().getWebView().getUrl(), getBridge().getAppUrl())) {
                call.reject("Refused: the connection plugin serves the bundled connect page only.");
                return;
            }
            background.execute(() -> {
                try {
                    call.resolve(work.apply(ShellServices.connector(getContext())));
                } catch (RuntimeException e) {
                    call.reject(e.getMessage());
                }
            });
        });
    }

    private JSObject present(ShellConnector.Outcome outcome, ShellConnector connector, String label) {
        JSObject result = list(connector);
        result.put("screen", outcome.screen);
        result.put("serverId", outcome.serverId);
        result.put("status", outcome.status);
        if (outcome.url != null) {
            Intent intent = new Intent(getContext(), ServerActivity.class);
            intent.putExtra(ServerActivity.EXTRA_URL, outcome.url);
            intent.putExtra(ServerActivity.EXTRA_SERVER_ID, outcome.serverId);
            intent.putExtra(ServerActivity.EXTRA_NOTE, outcome.note);
            if (ShellConnector.LOGIN.equals(outcome.screen)) {
                intent.putExtra(ServerActivity.EXTRA_PENDING_ORIGIN, outcome.url);
                intent.putExtra(ServerActivity.EXTRA_PENDING_LABEL, label);
            }
            getActivity().startActivity(intent);
        }
        return result;
    }

    private JSObject list(ShellConnector connector) {
        JSArray servers = new JSArray();
        for (ServerRecord server : connector.list()) {
            JSObject row = new JSObject();
            row.put("id", server.id);
            row.put("label", server.label);
            row.put("url", server.url);
            row.put("username", server.username);
            servers.put(row);
        }
        JSObject result = new JSObject();
        result.put("servers", servers);
        return result;
    }

    private String cookiesForLast(ShellConnector connector) {
        for (ServerRecord server : connector.list()) if (server.id.equals(connector.lastUsedId())) return cookies(server.url);
        return null;
    }

    private static String cookies(String url) {
        return CookieManager.getInstance().getCookie(url);
    }

    private static void clearWebsiteData(String url) {
        CookieManager cookies = CookieManager.getInstance();
        String header = cookies.getCookie(url);
        if (header != null) {
            for (String pair : header.split(";")) {
                String name = pair.split("=", 2)[0].trim();
                cookies.setCookie(url, name + "=; Max-Age=0");
            }
            cookies.flush();
        }
        android.webkit.WebStorage.getInstance().deleteOrigin(url);
    }
}
