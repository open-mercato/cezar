package com.openmercato.cezar.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import com.openmercato.cezar.mobile.shell.AppLock;
import com.openmercato.cezar.mobile.shell.LaunchHold;
import com.openmercato.cezar.mobile.shell.PageBack;
import com.openmercato.cezar.mobile.shell.QuickLaunch;
import com.openmercato.cezar.mobile.shell.RestartActivity;
import com.openmercato.cezar.mobile.shell.ServerActivity;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellRoute;
import com.openmercato.cezar.mobile.shell.ShellServices;
import com.openmercato.cezar.mobile.shell.push.PushTap;

/** Framework adapter: hosts the connect page and nothing else. */
public class MainActivity extends BridgeActivity implements AppLock.Host {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionPlugin.class);
        if (getIntent().getBooleanExtra(RestartActivity.EXTRA_SHOW_LIST, false)) ShellRoute.set(ShellConnector.LIST, getIntent().getStringExtra(RestartActivity.EXTRA_FROM));
        // A restored activity keeps its intent: only a fresh launch carries a tap.
        // The splash stays up while a plain start decides, so a server opens straight from it (LaunchHold).
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        if (savedInstanceState == null) {
            takeTap(getIntent());
            if (Intent.ACTION_MAIN.equals(getIntent().getAction()) && !AppLock.get(this).enabled()) {
                LaunchHold.SHARED.start();
                ShellServices.prewarm(this);
            }
        }
        splash.setKeepOnScreenCondition(LaunchHold.SHARED::holding);
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) openLastServerQuickly();
        // Added for every origin by the framework, and this page uses neither (M2 report, fix 2).
        bridge.getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
        bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        // Both webviews share a renderer. Unanswered, this callback kills the app (spec M2 item 2).
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                recreate();
                return true;
            }
        });
        // The page answers first and pops one screen (connect/nav.js); at a root with nowhere to go, the app leaves.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                bridge.getWebView().evaluateJavascript(PageBack.SCRIPT, answer -> {
                    if (!PageBack.handled(answer)) moveTaskToBack(true);
                });
            }
        });
    }

    /** The connect page stays under it and finds the server open when it launches (QuickLaunch). */
    private void openLastServerQuickly() {
        boolean locked = AppLock.get(this).enabled();
        ShellConnector connector = ShellServices.connector(this);
        String last = connector.lastUsedId();
        ServerRecord server = last == null ? null : connector.server(last);
        String path = server == null || server.relay == null || locked ? null : ShellServices.relay(this).quickPath(server);
        if (!QuickLaunch.applies(true, Intent.ACTION_MAIN.equals(getIntent().getAction()), locked, ShellRoute.pending(), PushTap.pending(), ServerActivity.isOpen(), path)) return;
        android.util.Log.i("CezarStart", "quick launch");
        ServerActivity.openQuick(this, server.id, path);
    }

    /** The server view sent the user back: the page re-reads the route through launch(). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeTap(intent);
        if (bridge != null) bridge.reload();
    }

    /** A tapped notification: `s` is a cezarId, opened by the connect page's next launch, behind the lock (spec R5). */
    private static void takeTap(Intent intent) {
        PushTap.offer(intent.getStringExtra(PushTap.EXTRA), intent.getStringExtra(PushTap.EXTRA_MANAGER));
        intent.removeExtra(PushTap.EXTRA);
        intent.removeExtra(PushTap.EXTRA_MANAGER);
    }
}
