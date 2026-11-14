package com.openmercato.cezar.mobile.shell;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Forget and Remove: deleteOrigin covers only quota-managed storage, not localStorage, where the
 * cockpit keeps its cached first screen. A throwaway document at that origin, loaded from a string
 * with no network and no bridge, clears it. Main thread only.
 */
public final class OriginWipe {
    static final String SCRIPT = "try{localStorage.clear();sessionStorage.clear();}catch(e){}";
    private static final long TIMEOUT_MS = 3000;

    private OriginWipe() {}

    @SuppressLint("SetJavaScriptEnabled")
    public static void wipe(Context context, String origin, Runnable done) {
        WebStorage.getInstance().deleteOrigin(origin);
        Handler main = new Handler(Looper.getMainLooper());
        WebView page = new WebView(context.getApplicationContext());
        page.getSettings().setJavaScriptEnabled(true);
        page.getSettings().setDomStorageEnabled(true);
        page.getSettings().setAllowFileAccess(false);
        page.getSettings().setAllowContentAccess(false);
        boolean[] finished = {false};
        Runnable end = () -> {
            if (finished[0]) return;
            finished[0] = true;
            page.destroy();
            if (done != null) done.run();
        };
        page.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(SCRIPT, value -> end.run());
            }
        });
        main.postDelayed(end, TIMEOUT_MS);
        page.loadDataWithBaseURL(origin + "/", "<!doctype html><title></title>", "text/html", "utf-8", null);
    }
}
