package com.openmercato.cezar.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import com.openmercato.cezar.mobile.shell.AppLock;
import com.openmercato.cezar.mobile.shell.OriginGate;
import com.openmercato.cezar.mobile.shell.RestartActivity;
import com.openmercato.cezar.mobile.shell.ProxyOrigin;
import com.openmercato.cezar.mobile.shell.ServerActivity;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellRoute;
import com.openmercato.cezar.mobile.shell.ShellServices;
import com.openmercato.cezar.mobile.push.PushNotifier;
import com.openmercato.cezar.mobile.shell.push.PushCoordinator;
import com.openmercato.cezar.mobile.shell.push.PushTap;
import com.openmercato.cezar.mobile.shell.relay.PairingClient;
import com.openmercato.cezar.mobile.shell.relay.PairingFlow;
import com.openmercato.cezar.mobile.shell.relay.RelayLink;
import com.openmercato.cezar.mobile.shell.relay.RelayOrigin;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/** Framework adapter for the connect page. All decisions live in the plain shell package. */
@CapacitorPlugin(name = "Connection", permissions = @Permission(alias = ConnectionPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class ConnectionPlugin extends Plugin {
    /** A QR string from the debug-only DebugPairActivity. Release builds have no way to set this route. */
    public static final String DEBUG_QR = "debug-qr";
    static final String NOTIFICATIONS = "notifications";
    private static final long POLL_MS = 20000;

    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private final ExecutorService polls = Executors.newCachedThreadPool();

    /** Waits for the lock, so a locked app opens no server and consumes no route behind it (spec QR3). */
    @PluginMethod
    public void launch(PluginCall call) {
        getActivity().runOnUiThread(() -> AppLock.get(getContext()).whenUnlocked(() -> start(call)));
    }

    private void start(PluginCall call) {
        PushCoordinator push = ShellServices.push(getContext());
        // § 7: an owed revoke is retried on each app open. Off the launch's thread, so the page never waits on the relay.
        polls.execute(push::retryRevokes);
        ShellRoute route = ShellRoute.take();
        if (route != null && BuildConfig.DEBUG && DEBUG_QR.equals(route.screen)) {
            run(call, connector -> pair(connector, ShellServices.pairing(getContext()).startQr(route.serverId)));
            return;
        }
        String tap = PushTap.take();
        if (tap != null) {
            run(call, connector -> {
                ShellConnector.Outcome outcome = PushTap.open(connector, tap, this::managerId);
                return outcome != null ? present(outcome, connector, null) : launchAsUsual(connector);
            });
            return;
        }
        if (route != null) {
            run(call, connector -> {
                JSObject result = list(connector);
                result.put("screen", route.screen);
                result.put("serverId", route.serverId);
                return result;
            });
            return;
        }
        run(call, this::launchAsUsual);
    }

    private JSObject launchAsUsual(ShellConnector connector) {
        if (ServerActivity.isOpen()) {
            JSObject result = list(connector);
            result.put("screen", ShellConnector.OPEN);
            return result;
        }
        return present(connector.launch(cookiesForLast(connector)), connector, null);
    }

    /** Asked in the session the open just made. The id never left it: the push carries only the cezarId. */
    private String managerId(ServerRecord server) {
        RelayLink link = ShellServices.relay(getContext()).link(server);
        if (link == null || link.session() == null) return null;
        try {
            return ShellServices.cezarPush(getContext(), link::session).get().managerId;
        } catch (IOException e) {
            return null;
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        run(call, connector -> {
            ServerRecord server = connector.server(id);
            return present(connector.open(id, server == null || server.url == null ? null : cookies(server.url)), connector, null);
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
            if (server != null) getActivity().runOnUiThread(() -> {
                if (server.relay != null) android.webkit.WebStorage.getInstance().deleteOrigin(new ProxyOrigin(server.relay.port).origin());
                else clearWebsiteData(server.url);
                if (ServerActivity.everOpened()) RestartActivity.restart(getActivity());
            });
            return list(connector);
        });
    }

    /** A relay server's Notifications switch. On asks Android 13+ for the permission first (spec R5). */
    @PluginMethod
    public void pushSet(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        getActivity().runOnUiThread(() -> {
            if (!allowed(call)) return;
            if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
                requestPermissionForAlias(NOTIFICATIONS, call, "pushPermission");
                return;
            }
            setPush(call, enabled);
        });
    }

    @PermissionCallback
    private void pushPermission(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            setPush(call, true);
            return;
        }
        run(call, connector -> {
            JSObject result = list(connector);
            result.put("pushError", "Allow notifications for Cezar in Android settings to turn this on.");
            return result;
        });
    }

    private void setPush(PluginCall call, boolean enabled) {
        String id = call.getString("id");
        run(call, connector -> {
            ShellServices.push(getContext()).setEnabled(connector.server(id), enabled);
            JSObject result = list(connector);
            if (enabled && !PushNotifier.allowed(getContext())) result.put("pushError", "Notifications for Cezar are off in Android settings.");
            return result;
        });
    }

    @PluginMethod
    public void lockSet(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        getActivity().runOnUiThread(() -> {
            if (!allowed(call)) return;
            AppLock.get(getContext()).change(getActivity(), enabled, error -> run(call, connector -> {
                JSObject result = list(connector);
                result.put("lockError", error);
                return result;
            }));
        });
    }

    /** Reads and opens nothing, unlike launch: the page calls it each time it returns to the foreground. */
    @PluginMethod
    public void list(PluginCall call) {
        run(call, this::list);
    }

    /** The system camera path is out of reach here: zxing's own activity, needing no Play services. */
    @PluginMethod
    public void scan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!allowed(call)) return;
            ScanOptions options = new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false)
                    .setOrientationLocked(true).setPrompt("Scan the code on your computer");
            startActivityForResult(call, options.createScanIntent(getContext()), "scanned");
        });
    }

    @ActivityCallback
    private void scanned(PluginCall call, ActivityResult result) {
        String contents = call == null ? null : ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData()).getContents();
        if (call == null) return;
        if (contents == null) {
            run(call, this::list);
            return;
        }
        run(call, connector -> pair(connector, ShellServices.pairing(getContext()).startQr(contents)));
    }

    @PluginMethod
    public void pairCode(PluginCall call) {
        String code = call.getString("code");
        String relay = call.getString("relay");
        run(call, connector -> pair(connector, ShellServices.pairing(getContext()).startCode(code, relay)));
    }

    @PluginMethod
    public void pairCancel(PluginCall call) {
        run(call, connector -> {
            ShellServices.pairing(getContext()).cancel();
            return list(connector);
        });
    }

    /** A long poll, on its own thread so that Cancel still gets through. */
    @PluginMethod
    public void pairPoll(PluginCall call) {
        int seq = call.getInt("seq", 0);
        getActivity().runOnUiThread(() -> {
            if (!allowed(call)) return;
            polls.execute(() -> {
                try {
                    ShellConnector connector = ShellServices.connector(getContext());
                    PairingFlow.Snapshot next = ShellServices.pairing(getContext()).next(seq, POLL_MS);
                    if (next.phase == PairingClient.Phase.APPROVED) {
                        call.resolve(present(connector.open(ShellServices.lastPaired(), null), connector, null, ShellServices.push(getContext()).shouldAsk()));
                    } else {
                        call.resolve(pair(connector, next));
                    }
                } catch (InterruptedException | RuntimeException e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            });
        });
    }

    private JSObject pair(ShellConnector connector, PairingFlow.Snapshot snapshot) {
        JSObject result = list(connector);
        result.put("screen", "pair");
        result.put("seq", snapshot.seq);
        result.put("phase", snapshot.phase.name().toLowerCase(java.util.Locale.ROOT));
        result.put("digits", snapshot.digits);
        result.put("label", snapshot.label);
        result.put("reason", snapshot.reason);
        return result;
    }

    private boolean allowed(PluginCall call) {
        if (OriginGate.allows(getBridge().getWebView().getUrl(), getBridge().getAppUrl())) return true;
        call.reject("Refused: the connection plugin serves the bundled connect page only.");
        return false;
    }

    /** Refuses before any work: WebView.getUrl is main-thread only, the work is not. */
    private void run(PluginCall call, Function<ShellConnector, JSObject> work) {
        getActivity().runOnUiThread(() -> {
            if (!allowed(call)) return;
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
        return present(outcome, connector, label, false);
    }

    /** `askPush`: the first relay pairing, whose server view asks once about notifications. */
    private JSObject present(ShellConnector.Outcome outcome, ShellConnector connector, String label, boolean askPush) {
        JSObject result = list(connector);
        result.put("screen", outcome.screen);
        result.put("serverId", outcome.serverId);
        result.put("status", outcome.status);
        if (outcome.url != null) {
            Intent intent = new Intent(getContext(), ServerActivity.class);
            intent.putExtra(ServerActivity.EXTRA_URL, outcome.url);
            intent.putExtra(ServerActivity.EXTRA_SERVER_ID, outcome.serverId);
            intent.putExtra(ServerActivity.EXTRA_NOTE, outcome.note);
            if (askPush) intent.putExtra(ServerActivity.EXTRA_ASK_PUSH, true);
            if (ShellConnector.LOGIN.equals(outcome.screen)) {
                intent.putExtra(ServerActivity.EXTRA_PENDING_ORIGIN, outcome.url);
                intent.putExtra(ServerActivity.EXTRA_PENDING_LABEL, label);
            }
            getActivity().startActivity(intent);
        }
        return result;
    }

    private JSObject list(ShellConnector connector) {
        PushCoordinator push = ShellServices.push(getContext());
        boolean pushAvailable = push.available();
        JSArray servers = new JSArray();
        for (ServerRecord server : connector.list()) {
            JSObject row = new JSObject();
            row.put("id", server.id);
            row.put("label", server.label);
            row.put("url", server.relay != null ? server.relay.origin : server.url);
            row.put("relay", server.relay != null);
            row.put("username", server.username);
            if (pushAvailable && server.relay != null) row.put("push", push.enabled(server.id));
            servers.put(row);
        }
        JSArray removing = new JSArray();
        for (String label : push.removing()) removing.put(label);
        JSObject result = new JSObject();
        result.put("servers", servers);
        result.put("removing", removing);
        result.put("pairing", true);
        result.put("relayDefault", RelayOrigin.DEFAULT_ORIGIN);
        AppLock lock = AppLock.get(getContext());
        result.put("lock", new JSObject().put("enabled", lock.enabled()).put("available", lock.available()));
        return result;
    }

    private String cookiesForLast(ShellConnector connector) {
        for (ServerRecord server : connector.list()) if (server.id.equals(connector.lastUsedId()) && server.url != null) return cookies(server.url);
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
                cookies.setCookie(url, name + "=; Max-Age=0; Path=/; Secure");
            }
            cookies.flush();
        }
        android.webkit.WebStorage.getInstance().deleteOrigin(url);
    }
}
