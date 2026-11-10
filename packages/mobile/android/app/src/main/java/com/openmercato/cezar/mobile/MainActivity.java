package com.openmercato.cezar.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import com.openmercato.cezar.mobile.shell.RestartActivity;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellRoute;

/** Framework adapter: hosts the connect page and nothing else. */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionPlugin.class);
        if (getIntent().getBooleanExtra(RestartActivity.EXTRA_SHOW_LIST, false)) ShellRoute.set(ShellConnector.LIST, null);
        super.onCreate(savedInstanceState);
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
    }

    /** The server view sent the user back: the page re-reads the route through launch(). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (bridge != null) bridge.reload();
    }
}
