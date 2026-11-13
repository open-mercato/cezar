package com.openmercato.cezar.mobile.shell;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
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
import android.os.SystemClock;
import android.util.Log;
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
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import com.openmercato.cezar.mobile.push.PushNotifier;
import com.openmercato.cezar.mobile.shell.push.ForegroundServers;
import com.openmercato.cezar.mobile.shell.push.GraceClose;
import com.openmercato.cezar.mobile.shell.push.PushCoordinator;
import com.openmercato.cezar.mobile.shell.push.SignalStream;
import com.openmercato.cezar.mobile.shell.relay.AccountClient;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import com.openmercato.cezar.mobile.shell.relay.LoopbackProxy;
import com.openmercato.cezar.mobile.shell.relay.RelayConnections;
import com.openmercato.cezar.mobile.shell.relay.RelayLink;
import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import com.openmercato.cezar.mobile.shell.relay.TunnelSession;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts server pages in a plain WebView with no bridge, so page script has no path to native code
 * by construction (spec "No native bridge on server pages"). The framework's webview only ever
 * shows the bundled connect page.
 */
public final class ServerActivity extends AppCompatActivity implements AppLock.Host {
    public static final String EXTRA_SERVER_ID = "serverId";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_NOTE = "note";
    /** The origin of an SSO add that is not saved yet. */
    public static final String EXTRA_PENDING_ORIGIN = "pendingOrigin";
    public static final String EXTRA_PENDING_LABEL = "pendingLabel";
    /** The first relay pairing: ask once, with the session up, whether to turn notifications on (spec R5). */
    public static final String EXTRA_ASK_PUSH = "askPush";
    private static final String STATE_URL = "lastUrl";

    /** One that is finishing, as under a cleared task, no longer counts as open. Read from the plugin's thread too. */
    private static final java.util.Set<ServerActivity> open = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
    private static boolean everOpened;

    private static final int FILE_CHOOSER = 1;
    /** The cockpit's dark background, behind the system bars. */
    private static final int BAR_COLOR = 0xFF0D0D0D;

    /** Native, because the cockpit cannot reliably describe its own transport. */
    private static final int BANNER_COLOR = 0xF0401010;
    /** The § 18 reminder is not a failure, so it is not red. */
    private static final int REMINDER_COLOR = 0xF0263238;

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
    private Button bannerServers;
    /** The § 18 reminder, while the computer's email waits; null when there is nothing to say. */
    private String reminder;
    /** The banner's button is Confirm, not Retry. */
    private boolean bannerConfirms;
    private long notReadySince;
    private boolean reloadWhenReady;
    private final Runnable bannerTick = this::showBanner;
    /** The launch view, held over the page until it has drawn: never a blank webview, never a logo that stays. */
    private LaunchView cover;
    private StartupWatchdog watchdog;
    private StartupLog startLog;
    private String startStatus;
    /** Bumped by every start and Retry, so a late paint answer from an earlier document is dropped. */
    private int startGeneration;
    private long paintAskedAt = -1;
    private boolean begun;
    private String startUrl;
    private final Runnable startTick = this::startTick;
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
    /** Once per view: the first session settles this phone's push grant with cezar. */
    private boolean pushSynced;
    private boolean askPush;
    private ActivityResultLauncher<String> notificationPermission;
    private boolean started;
    /** The socket closes 30 s after stop, so a Stage 1 signal in that window still shows (spec R5 as built). */
    private GraceClose grace;
    private SignalStream signals;

    /** A reloaded connect page must not stack a second server view on a live one. */
    public static boolean isOpen() {
        synchronized (open) {
            for (ServerActivity activity : open) if (!activity.isFinishing()) return true;
        }
        return QuickLaunch.launching();
    }

    /** The launcher's fast path (QuickLaunch): the last relay server, from its cached bundle. */
    public static void openQuick(android.app.Activity from, String serverId, String path) {
        QuickLaunch.started();
        Intent intent = new Intent(from, ServerActivity.class);
        intent.putExtra(EXTRA_URL, path);
        intent.putExtra(EXTRA_SERVER_ID, serverId);
        from.startActivity(intent);
        from.overridePendingTransition(0, 0);
    }

    /** Whether this process has a webview auth cache to worry about. */
    public static boolean everOpened() {
        return everOpened;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        synchronized (open) {
            open.add(this);
        }
        QuickLaunch.arrived();
        everOpened = true;
        connector = ShellServices.connector(this);
        Intent intent = getIntent();
        // Registered before STARTED, as the API requires; used only by the one-time question.
        notificationPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) turnPushOn();
        });
        askPush = savedInstanceState == null && intent.getBooleanExtra(EXTRA_ASK_PUSH, false);
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
        ServerRecord record = pendingLogin ? null : connector.server(serverId);
        watchdog = new StartupWatchdog(record != null ? record.label : pendingLabel, link != null);
        startLog = ShellServices.startupLog(this);
        startLog.begin("open " + (link != null ? "relay " + relayHost(record) : "direct") + (savedInstanceState != null ? " (restored)" : "")
                + ", app " + ShellServices.installStamp(this) + ", webview " + webViewVersion());
        addCover();
        if (savedInstanceState != null) restoreUrl = savedInstanceState.getString(STATE_URL);
        startUrl = proxy == null ? intent.getStringExtra(EXTRA_URL) : origin.url(intent.getStringExtra(EXTRA_URL));
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
        proxy.setOnShellChanged(() -> main.post(() -> {
            // The shell painted from the phone was older than the server's: load the new one once.
            if (webView != null && !isDestroyed() && !leaving) webView.reload();
        }));
        if (proxy.port() != saved) connector.saveRelayPort(serverId, proxy.port());
        origin = new ProxyOrigin(proxy.port());
        RelayLink opened = link;
        LoopbackProxy mine = proxy;
        grace = new GraceClose(new GraceClose.Scheduler() {
            @Override
            public void schedule(Runnable task, long delayMs) {
                main.postDelayed(task, delayMs);
            }

            @Override
            public void cancel(Runnable task) {
                main.removeCallbacks(task);
            }
        }, () -> {
            if (!relayConnections.holds(mine)) return;
            opened.setListener(null);
            opened.stop();
        });
        signals = signalStream(server, opened, mine);
        return true;
    }

    /** Wanted while this session is up, the switch is on and Android lets the app notify. */
    private SignalStream signalStream(ServerRecord server, RelayLink opened, LoopbackProxy mine) {
        Context app = getApplicationContext();
        RelayConnections connections = relayConnections;
        PushCoordinator push = ShellServices.push(app);
        String id = server.id;
        String cezarId = server.relay.cezarId;
        return new SignalStream(ShellServices.signals(app, opened::session), () -> {
            TunnelSession session = opened.session();
            return session != null && session.live() && connections.holds(mine) && push.enabled(id) && PushNotifier.allowed(app);
        }, managerId -> {
            if (ForegroundServers.SHARED.shouldNotify(id) && push.enabled(id)) PushNotifier.post(app, cezarId, 0, managerId);
        }, new SecureRandom());
    }

    private void ensureSignals() {
        if (signals == null || isDestroyed()) return;
        signals.ensureRunning(run -> {
            Thread thread = new Thread(run, "cezar-signals");
            thread.setDaemon(true);
            thread.start();
        });
    }

    /** The callback is what guarantees the cookie reaches the first request (spec R0 question 2). */
    private void setGateCookieThenLoad(String url) {
        CookieManager cookies = CookieManager.getInstance();
        String cookie = LoopbackProxy.COOKIE + "=" + proxy.cookieValue() + "; Path=/; HttpOnly; SameSite=Strict";
        cookies.setCookie(origin.origin(), cookie, stored -> {
            cookies.flush();
            // A Retry may ask again while the first answer is still on its way.
            if (!isDestroyed() && webView == null) addWebView(url);
        });
    }

    private void onRelayStatus(RelayStatus status) {
        main.post(() -> {
            if (isDestroyed() || leaving) return;
            if (cover != null) {
                startLog.step("relay " + status.kind);
                watchdog.relayStatus(status.kind, SystemClock.uptimeMillis());
                // A 503 from the proxy put the problem up; the session it waited for is here now.
                if (status.kind == RelayStatus.Kind.READY && reloadWhenReady && cover.showingProblem()) {
                    reloadWhenReady = false;
                    retryStart();
                }
            }
            if (status.kind == RelayStatus.Kind.READY) ensureSignals();
            // In the grace window only the stream matters: the screen catches up when it starts again.
            if (!started) return;
            if (status.kind == RelayStatus.Kind.EMAIL_UNCONFIRMED || status.kind == RelayStatus.Kind.ACCOUNT_REQUIRED) {
                // § 18: the relay refuses until the computer's email is confirmed. Nothing is lost, so nothing is wiped.
                leave(status.kind == RelayStatus.Kind.EMAIL_UNCONFIRMED ? ShellConnector.EMAIL_UNCONFIRMED : ShellConnector.ACCOUNT_REQUIRED);
                return;
            }
            if (status.kind == RelayStatus.Kind.DEVICE_REMOVED) {
                // Removed by the computer: what this server left on the phone goes, as on Forget.
                relayConnections.forgetBundle(serverId);
                OriginWipe.wipe(this, origin.origin(), null);
                leave(ShellConnector.DEVICE_REMOVED);
                return;
            }
            if (status.kind == RelayStatus.Kind.READY) {
                notReadySince = 0;
                onSessionUp();
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

    private void onSessionUp() {
        if (!pushSynced) {
            pushSynced = true;
            syncPush();
            checkAccount();
        }
        if (askPush) {
            askPush = false;
            askAboutPush();
        }
    }

    /** Once per view: a gentle reminder while the computer's email waits for confirmation (§ 18). */
    private void checkAccount() {
        ServerRecord server = connector.server(serverId);
        if (server == null || server.relay == null) return;
        DeviceKeys keys = ShellServices.deviceKeysFor(this, server.id);
        if (keys == null) return;
        background.execute(() -> {
            try {
                AccountClient.Status status = ShellServices.accounts().status(server.relay.origin, keys, server.relay.cezarId);
                String text = AccountReminder.text(status);
                main.post(() -> {
                    reminder = text;
                    showBanner();
                });
            } catch (AccountClient.Failure ignored) {
                // An older relay, or none to ask: no reminder.
            }
        });
    }

    /** Off the main thread: the grant may need the relay and cezar both. */
    private void syncPush() {
        ServerRecord server = connector.server(serverId);
        RelayLink current = link;
        if (server == null || current == null) return;
        background.execute(() -> ShellServices.push(this).sync(server, ShellServices.cezarPush(this, current::session)));
    }

    private void askAboutPush() {
        ShellServices.push(this).markAsked();
        new AlertDialog.Builder(this)
                .setTitle("Get notified?")
                .setMessage("Cezar can tell this phone when it needs you. The notification says only that, and you can turn it off on the Servers list.")
                .setPositiveButton("Turn on", (dialog, which) -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
                    else turnPushOn();
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    private void turnPushOn() {
        ServerRecord server = connector.server(serverId);
        if (server == null || isDestroyed()) return;
        background.execute(() -> {
            ShellServices.push(this).setEnabled(server, true);
            main.post(this::ensureSignals);
        });
        syncPush();
    }

    private void showBanner() {
        main.removeCallbacks(bannerTick);
        if (link == null) return;
        RelayStatus status = link.status();
        boolean counting = status.kind != RelayStatus.Kind.READY && status.kind != RelayStatus.Kind.IDLE && notReadySince != 0;
        long waited = counting ? System.currentTimeMillis() - notReadySince : 0;
        ConnectionBanner banner = counting ? ConnectionBanner.of(status, waited) : null;
        if (banner == null && reminder != null && status.kind == RelayStatus.Kind.READY) {
            if (bannerView == null) addBannerView();
            bannerConfirms = true;
            bannerView.setBackgroundColor(REMINDER_COLOR);
            bannerText.setText(reminder);
            bannerRetry.setText("Confirm");
            bannerRetry.setVisibility(View.VISIBLE);
            bannerServers.setVisibility(View.GONE);
            bannerView.setVisibility(View.VISIBLE);
            bannerView.bringToFront();
            return;
        }
        if (banner == null) {
            if (bannerView != null) bannerView.setVisibility(View.GONE);
            if (counting && waited < ConnectionBanner.GRACE_MS) main.postDelayed(bannerTick, ConnectionBanner.GRACE_MS - waited);
            return;
        }
        if (bannerView == null) addBannerView();
        bannerConfirms = false;
        bannerView.setBackgroundColor(BANNER_COLOR);
        bannerText.setText(banner.text);
        bannerRetry.setText("Retry");
        bannerServers.setVisibility(View.VISIBLE);
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
        bannerRetry.setOnClickListener(view -> {
            if (bannerConfirms) leave(ShellConnector.EMAIL_PENDING);
            else link.retryNow();
        });
        bannerView.addView(bannerRetry);
        bannerServers = new Button(this);
        bannerServers.setText("Servers");
        bannerServers.setOnClickListener(view -> leave(ShellConnector.LIST));
        bannerView.addView(bannerServers);
        frame.addView(bannerView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    /**
     * The page is served only while on screen, and the port stays bound and answers 503 (spec). The
     * socket itself closes 30 s after stop, for Stage 1 signals, unless the screen starts again first.
     */
    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        // The lock answers before anything connects or loads (spec QR3); its shield is over all of this.
        AppLock.get(this).whenUnlocked(this::startUnlocked);
    }

    private void startUnlocked() {
        if (!started || isDestroyed() || leaving) return;
        if (!begun) begin();
        if (link == null) return;
        ForegroundServers.SHARED.started(serverId);
        grace.started();
        proxy.setServing(true);
        link.setListener(this::onRelayStatus);
        link.start();
    }

    @Override
    protected void onStop() {
        super.onStop();
        started = false;
        if (link == null) return;
        ForegroundServers.SHARED.stopped(serverId);
        main.removeCallbacks(bannerTick);
        proxy.setServing(false);
        notReadySince = 0;
        grace.stopped();
    }

    private void addCover() {
        cover = new LaunchView(this, this::retryStart, () -> leave(ShellConnector.LIST));
        cover.status(watchdog.decide(SystemClock.uptimeMillis()).text);
        frame.addView(cover, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // The system splash goes once this has drawn over it: from here the status is live.
        cover.post(LaunchHold.SHARED::release);
    }

    /** The first unlocked start: the page loads and every step's deadline runs. */
    private void begin() {
        begun = true;
        startGeneration++;
        watchdog.start(SystemClock.uptimeMillis());
        if (link != null) watchdog.relayStatus(link.status().kind, SystemClock.uptimeMillis());
        startLog.step("load " + (proxy == null ? "direct" : relayCache()));
        if (proxy == null) addWebView(startUrl);
        else setGateCookieThenLoad(startUrl);
        main.removeCallbacks(startTick);
        main.post(startTick);
    }

    private void retryStart() {
        if (cover == null || isDestroyed() || leaving) return;
        startLog.step("retry");
        startGeneration++;
        paintAskedAt = -1;
        startStatus = null;
        long now = SystemClock.uptimeMillis();
        watchdog.start(now);
        if (link != null) {
            watchdog.relayStatus(link.status().kind, now);
            if (link.status().kind != RelayStatus.Kind.READY) link.retryNow();
        }
        cover.status(watchdog.decide(now).text);
        if (webView != null) webView.loadUrl(startUrl);
        else if (proxy == null) addWebView(startUrl);
        else setGateCookieThenLoad(startUrl);
        main.removeCallbacks(startTick);
        main.post(startTick);
    }

    /**
     * On a timer, never inside a paint answer: an evaluateJavascript callback is dropped when its
     * document goes (the cached shell replaced by a newer one), and that is what left the logo up for good.
     */
    private void startTick() {
        if (cover == null || isDestroyed() || leaving) return;
        long now = SystemClock.uptimeMillis();
        askPainted(now);
        StartupWatchdog.Decision decision = watchdog.decide(now);
        switch (decision.kind) {
            case REVEAL:
                removeCover();
                return;
            case PROBLEM:
                startLog.step("problem: " + decision.text);
                cover.problem(decision.text);
                return;
            default:
                if (!decision.text.equals(startStatus)) {
                    startStatus = decision.text;
                    cover.status(decision.text);
                }
                main.postDelayed(startTick, FirstPaint.POLL_MS);
        }
    }

    private void askPainted(long now) {
        if (webView == null || (paintAskedAt >= 0 && now - paintAskedAt < 1000)) return;
        paintAskedAt = now;
        int generation = startGeneration;
        webView.evaluateJavascript(FirstPaint.SCRIPT, answer -> {
            paintAskedAt = -1;
            if (generation != startGeneration || cover == null) return;
            if ("true".equals(answer)) watchdog.painted();
        });
    }

    private void removeCover() {
        if (cover == null) return;
        View gone = cover;
        cover = null;
        main.removeCallbacks(startTick);
        long sinceStart = SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis();
        startLog.step("shown, " + sinceStart + " ms after process start");
        // Logcat only, for measuring a start: no page content, no server name.
        Log.i("CezarStart", "painted " + sinceStart + " ms after process start");
        gone.animate().alpha(0f).setDuration(150).withEndAction(() -> frame.removeView(gone));
    }

    private String relayCache() {
        ServerRecord server = connector.server(serverId);
        return server != null && relayConnections.quickPath(server) != null ? "from cached bundle" : "through the relay (no cached bundle)";
    }

    /** The relay's host is what tells an old pairing (rome.patzick.workers.dev) from the new one. */
    private static String relayHost(ServerRecord server) {
        if (server == null || server.relay == null) return "?";
        return Uri.parse(server.relay.origin).getHost();
    }

    private static String webViewVersion() {
        android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
        return info == null ? "?" : info.versionName;
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
        // Under the cover, which stays until the page has drawn.
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
        synchronized (open) {
            open.remove(this);
        }
        main.removeCallbacks(startTick);
        if (grace != null) grace.cancel();
        if (signals != null) signals.stop();
        background.shutdown();
        if (webView != null) webView.destroy();
        if (proxy != null) relayConnections.release(proxy);
        super.onDestroy();
    }

    /** Null lets the request go; anything else answers it. */
    private WebResourceResponse gated(WebResourceRequest request) {
        if (!RequestGate.blocks(origin, request.getUrl().toString())) return null;
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
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
            return gated(request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameUrl = url;
            if (cover != null && url != null && url.startsWith("http")) {
                startLog.step("first byte");
                watchdog.firstByte(SystemClock.uptimeMillis());
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (cover != null && url != null && url.startsWith("http")) {
                startLog.step("page loaded");
                watchdog.loaded(SystemClock.uptimeMillis());
            }
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
            if (link != null && request.isForMainFrame() && (status == 502 || status == 503)) {
                reloadWhenReady = true;
                if (cover != null) {
                    startLog.step("proxy " + status);
                    watchdog.failed(status == 503 ? "No connection to cezar came up in time." : "cezar's answer was cut off on the way.");
                }
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            if (cover != null) {
                startLog.step("load error " + error.getErrorCode());
                watchdog.failed("Loading the cockpit failed: " + error.getDescription());
                return;
            }
            leave(ShellConnector.CONNECTION_ERROR);
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
                // A blank popup is a document too: script can write a request into it.
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView popupView, WebResourceRequest request) {
                    return gated(request);
                }

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
