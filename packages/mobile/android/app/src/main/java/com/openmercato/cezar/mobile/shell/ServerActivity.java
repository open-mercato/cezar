package com.openmercato.cezar.mobile.shell;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebStorage;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import com.openmercato.cezar.mobile.shell.relay.LoopbackProxy;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.RelayLink;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts server pages in a plain WebView with no bridge, so page script has no path to native code
 * by construction (spec "No native bridge on server pages"). The framework's webview only ever
 * shows the bundled connect page.
 */
public final class ServerActivity extends AppCompatActivity {
    public static final String EXTRA_SERVER_ID = "serverId";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_NOTE = "note";
    /** The origin of an SSO add that is not saved yet. */
    public static final String EXTRA_PENDING_ORIGIN = "pendingOrigin";
    public static final String EXTRA_PENDING_LABEL = "pendingLabel";
    private static final String STATE_URL = "lastUrl";

    private static int openCount;
    private static boolean everOpened;

    private static final int FILE_CHOOSER = 1;
    /** The cockpit's dark background, behind the system bars. */
    private static final int BAR_COLOR = 0xFF0D0D0D;

    /** Native, because the cockpit cannot reliably describe its own transport. */
    private static final int BANNER_COLOR = 0xF0401010;

    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ShellConnector connector;
    private PageOrigin origin;
    /** Set on a relay server only. The Manual path never touches these. */
    private RelayConnections relayConnections;
    private RelayLink link;
    private LoopbackProxy proxy;
    private LinearLayout bannerView;
    private TextView bannerText;
    private Button bannerRetry;
    private long notReadySince;
    private boolean reloadWhenReady;
    private final Runnable bannerTick = this::showBanner;
    private String serverId;
    private String pendingLabel;
    private boolean pendingLogin;
    private BasicChallengeResponder responder;
    private FrameLayout frame;
    private WebView webView;
    private String mainFrameUrl;
    /** Where the user was, reloaded after the start URL has put the origin in the auth cache. */
    private String restoreUrl;
    private ValueCallback<Uri[]> fileCallback;
    private boolean leaving;

    /** A reloaded connect page must not stack a second server view on a live one. */
    public static boolean isOpen() {
        return openCount > 0;
    }

    /** Whether this process has a webview auth cache to worry about. */
    public static boolean everOpened() {
        return everOpened;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        openCount++;
        everOpened = true;
        connector = ShellServices.connector(this);
        Intent intent = getIntent();
        serverId = intent.getStringExtra(EXTRA_SERVER_ID);
        String pendingOrigin = intent.getStringExtra(EXTRA_PENDING_ORIGIN);
        pendingLogin = pendingOrigin != null;
        pendingLabel = intent.getStringExtra(EXTRA_PENDING_LABEL);
        try {
            if (pendingLogin) {
                origin = ServerOrigin.parse(pendingOrigin);
            } else {
                ServerRecord server = connector.server(serverId);
                if (server == null) {
                    leave(ShellConnector.LIST);
                    return;
                }
                if (server.relay != null) {
                    if (!openProxy(server)) return;
                } else {
                    origin = server.origin();
                    responder = new BasicChallengeResponder(server, connector::password);
                }
            }
        } catch (ServerOrigin.InvalidUrl e) {
            leave(ShellConnector.LIST);
            return;
        }
        frame = new FrameLayout(this);
        frame.setBackgroundColor(BAR_COLOR);
        setContentView(frame);
        insetForSystemBars();
        if (savedInstanceState != null) restoreUrl = savedInstanceState.getString(STATE_URL);
        if (proxy == null) addWebView(intent.getStringExtra(EXTRA_URL));
        else setGateCookieThenLoad(origin.url(intent.getStringExtra(EXTRA_URL)));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) webView.goBack();
                else if (pendingLogin) leave(ShellConnector.NOT_CEZAR);
                else moveTaskToBack(true);
            }
        });
        String note = intent.getStringExtra(EXTRA_NOTE);
        if (note != null) Toast.makeText(this, note, Toast.LENGTH_LONG).show();
    }

    /** One listener, its port saved. A taken port is hostile: its origin's storage goes, and the page loads anew (spec). */
    private boolean openProxy(ServerRecord server) {
        relayConnections = ShellServices.relay(this);
        try {
            proxy = relayConnections.openProxy(server);
        } catch (IOException e) {
            relayConnections.release();
            leave(ShellConnector.CONNECTION_ERROR);
            return false;
        }
        link = relayConnections.link(server);
        int saved = server.relay.port;
        if (proxy.rebound()) WebStorage.getInstance().deleteOrigin(new ProxyOrigin(saved).origin());
        if (proxy.port() != saved) connector.saveRelayPort(serverId, proxy.port());
        origin = new ProxyOrigin(proxy.port());
        return true;
    }

    /** The callback is what guarantees the cookie reaches the first request (spec R0 question 2). */
    private void setGateCookieThenLoad(String url) {
        CookieManager cookies = CookieManager.getInstance();
        String cookie = LoopbackProxy.COOKIE + "=" + proxy.cookieValue() + "; Path=/; HttpOnly; SameSite=Strict";
        cookies.setCookie(origin.origin(), cookie, stored -> {
            cookies.flush();
            if (!isDestroyed()) addWebView(url);
        });
    }

    private void onRelayStatus(RelayStatus status) {
        main.post(() -> {
            if (isDestroyed() || leaving) return;
            if (status.kind == RelayStatus.Kind.DEVICE_REMOVED) {
                leave(ShellConnector.DEVICE_REMOVED);
                return;
            }
            if (status.kind == RelayStatus.Kind.READY) {
                notReadySince = 0;
                if (reloadWhenReady && webView != null) {
                    reloadWhenReady = false;
                    webView.reload();
                }
            } else if (notReadySince == 0 && status.kind != RelayStatus.Kind.IDLE) {
                notReadySince = System.currentTimeMillis();
            }
            showBanner();
        });
    }

    private void showBanner() {
        main.removeCallbacks(bannerTick);
        if (link == null) return;
        RelayStatus status = link.status();
        boolean counting = status.kind != RelayStatus.Kind.READY && status.kind != RelayStatus.Kind.IDLE && notReadySince != 0;
        long waited = counting ? System.currentTimeMillis() - notReadySince : 0;
        ConnectionBanner banner = counting ? ConnectionBanner.of(status, waited) : null;
        if (banner == null) {
            if (bannerView != null) bannerView.setVisibility(View.GONE);
            if (counting && waited < ConnectionBanner.GRACE_MS) main.postDelayed(bannerTick, ConnectionBanner.GRACE_MS - waited);
            return;
        }
        if (bannerView == null) addBannerView();
        bannerText.setText(banner.text);
        bannerRetry.setVisibility(banner.retry ? View.VISIBLE : View.GONE);
        bannerView.setVisibility(View.VISIBLE);
        bannerView.bringToFront();
    }

    private void addBannerView() {
        bannerView = new LinearLayout(this);
        bannerView.setOrientation(LinearLayout.HORIZONTAL);
        bannerView.setGravity(Gravity.CENTER_VERTICAL);
        bannerView.setBackgroundColor(BANNER_COLOR);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);
        bannerView.setPadding(pad, pad / 2, pad / 2, pad / 2);
        // A touch on the banner must not reach the page under it.
        bannerView.setClickable(true);
        bannerText = new TextView(this);
        bannerText.setTextColor(Color.WHITE);
        bannerView.addView(bannerText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        bannerRetry = new Button(this);
        bannerRetry.setText("Retry");
        bannerRetry.setOnClickListener(view -> link.retryNow());
        bannerView.addView(bannerRetry);
        Button servers = new Button(this);
        servers.setText("Servers");
        servers.setOnClickListener(view -> leave(ShellConnector.LIST));
        bannerView.addView(servers);
        frame.addView(bannerView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    /** Foreground only: the socket closes with the screen, and the port stays bound and answers 503 (spec). */
    @Override
    protected void onStart() {
        super.onStart();
        if (link == null) return;
        proxy.setServing(true);
        link.setListener(this::onRelayStatus);
        link.start();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (link == null) return;
        main.removeCallbacks(bannerTick);
        link.setListener(null);
        link.stop();
        proxy.setServing(false);
        notReadySince = 0;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void addWebView(String url) {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSaveFormData(false);
        settings.setUserAgentString(settings.getUserAgentString() + " " + ShellServices.userAgentToken(this));
        webView.setWebViewClient(new ServerClient());
        webView.setWebChromeClient(new ServerChrome());
        frame.addView(webView, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        mainFrameUrl = url;
        webView.loadUrl(url);
    }

    /** Edge-to-edge is forced at this target SDK, and the page's env() does not see bars or keyboard. */
    private void insetForSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        getWindow().getInsetsController().setSystemBarsAppearance(0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        frame.setOnApplyWindowInsetsListener((View view, WindowInsets insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private void leave(String screen) {
        if (leaving) return;
        leaving = true;
        ShellRoute.set(screen, serverId);
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }

    private void openExternally(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, url, Toast.LENGTH_LONG).show();
        }
    }

    /** A native probe asks the exact origin, which the challenge callback cannot. */
    private void verifyPassword() {
        String cookies = CookieManager.getInstance().getCookie(origin.origin());
        String id = serverId;
        background.execute(() -> {
            if (ShellConnector.PASSWORD_REJECTED.equals(connector.open(id, cookies).screen)) {
                main.post(() -> leave(ShellConnector.PASSWORD_REJECTED));
            }
        });
    }

    private void confirmPendingLogin() {
        String label = pendingLabel;
        String cookies = CookieManager.getInstance().getCookie(origin.origin());
        background.execute(() -> {
            ShellConnector.Outcome outcome = connector.confirmLogin(origin.origin(), cookies, label);
            if (!ShellConnector.OPEN.equals(outcome.screen)) return;
            main.post(() -> {
                pendingLogin = false;
                serverId = outcome.serverId;
                responder = new BasicChallengeResponder(connector.server(serverId), connector::password);
                webView.loadUrl(outcome.url);
            });
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        // The cockpit routes with pushState, so only the webview knows the current URL.
        if (webView != null && origin.sameOrigin(webView.getUrl())) state.putString(STATE_URL, webView.getUrl());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
    }

    @Override
    protected void onDestroy() {
        openCount--;
        background.shutdown();
        if (webView != null) webView.destroy();
        if (proxy != null) relayConnections.release(proxy);
        super.onDestroy();
    }

    private final class ServerClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            switch (NavigationPolicy.decide(origin, url, view.getUrl(), request.isForMainFrame(), request.isRedirect())) {
                case SERVERS:
                    leave(ShellConnector.LIST);
                    return true;
                case EXTERNAL:
                    openExternally(url);
                    return true;
                case BLOCK:
                    return true;
                default:
                    if (request.isForMainFrame()) mainFrameUrl = url;
                    return false;
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!RequestGate.blocks(origin, request.getUrl().toString())) return null;
            return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameUrl = url;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (responder != null) responder.onStartPageLoaded();
            if (restoreUrl != null) {
                String target = restoreUrl;
                restoreUrl = null;
                if (origin.sameOrigin(target) && !target.equals(url)) view.loadUrl(target);
            }
            if (pendingLogin && origin.sameOrigin(url)) confirmPendingLogin();
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            if (responder == null) {
                handler.cancel();
                return;
            }
            BasicChallengeResponder.Reply reply = responder.onChallenge(host, realm, mainFrameUrl, !handler.useHttpAuthUsernamePassword());
            switch (reply.kind) {
                case ANSWER:
                    handler.proceed(reply.username == null ? "" : reply.username, reply.password);
                    break;
                case CANCEL_REJECTED:
                    handler.cancel();
                    leave(ShellConnector.PASSWORD_REJECTED);
                    break;
                case CANCEL_VERIFY:
                    handler.cancel();
                    verifyPassword();
                    break;
                default:
                    handler.cancel();
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (origin.sameOrigin(error.getUrl())) leave(ShellConnector.TLS_FAILURE);
        }

        /** The proxy answered 502 or 503 with no session: the page reloads once one exists. */
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            int status = response.getStatusCode();
            if (link != null && request.isForMainFrame() && (status == 502 || status == 503)) reloadWhenReady = true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) leave(ShellConnector.CONNECTION_ERROR);
        }

        /** Without this the whole app dies with the renderer (spec M2 item 2). */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            String url = origin.sameOrigin(view.getUrl()) ? view.getUrl() : getIntent().getStringExtra(EXTRA_URL);
            frame.removeView(view);
            view.destroy();
            addWebView(url);
            return true;
        }
    }

    private final class ServerChrome extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message resultMsg) {
            WebView popup = new WebView(ServerActivity.this);
            popup.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView popupView, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    NavigationPolicy.Action action = NavigationPolicy.decideWindow(origin, url);
                    if (action == NavigationPolicy.Action.ALLOW) webView.loadUrl(url);
                    else if (action == NavigationPolicy.Action.EXTERNAL) openExternally(url);
                    popupView.post(popupView::destroy);
                    return true;
                }
            });
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_CHOOSER);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }
    }
}
