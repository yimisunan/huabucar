package local.catcanvas.launcher;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TAG = "CatCanvasLauncher";
    private static final String TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String BASE = "http://127.0.0.1:8899";
    private static final String PAGE = BASE + "/%E5%9B%BE%E7%89%87%E7%94%9F%E6%88%90%E7%94%BB%E5%B8%83%E7%89%88.html";
    private static final String START_SCRIPT = "/data/data/com.termux/files/home/.termux/catcanvas/start.sh";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private TextView status;
    private ProgressBar progress;
    private Button retry;
    private boolean busy;
    private boolean settingsRequired;
    private boolean resumed;
    private int attempt;
    private static final long START_TIMEOUT_MS = 45000;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
        start();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!busy) start();
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        view.setPadding(0, dp(8), 0, dp(8));
        return view;
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(250,245,239));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.setPadding(dp(24), dp(24), dp(24), dp(24));
        scroll.addView(content, new ScrollView.LayoutParams(-1, -1));
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.app_icon);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        content.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));
        TextView title = text("猫画布", 28, Color.rgb(63,42,32));
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        content.addView(title);
        status = text("正在检查画布服务…", 17, Color.rgb(91,70,58));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status);
        progress = new ProgressBar(this);
        content.addView(progress, new LinearLayout.LayoutParams(dp(40), dp(40)));
        retry = new Button(this);
        retry.setText("重试");
        retry.setMinHeight(dp(48));
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> {
            if (settingsRequired) startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            else start();
        });
        LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-1, -2);
        action.topMargin = dp(16);
        content.addView(retry, action);
        Button termux = new Button(this);
        termux.setText("打开 Termux");
        termux.setMinHeight(dp(48));
        termux.setOnClickListener(v -> openTermux());
        content.addView(termux, new LinearLayout.LayoutParams(-1, -2));
        setContentView(scroll);
    }

    private void start() {
        if (busy || isFinishing()) return;
        busy = true;
        settingsRequired = false;
        progress.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);
        retry.setText("重试");
        status.setText("正在检查画布服务…");
        worker.execute(() -> {
            boolean ready = serverReady();
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (ready) {
                    Log.i(TAG, "Reusing existing server");
                    openBrowser();
                } else {
                    launchServer();
                }
            });
        });
    }

    private boolean serverReady() {
        try {
            JSONObject json = new JSONObject(read(BASE + "/api/ping", 4096));
            return json.optBoolean("ok") && read(PAGE, 8192).contains("猫画布");
        } catch (Exception e) { return false; }
    }

    private String read(String url, int limit) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection(Proxy.NO_PROXY);
        connection.setConnectTimeout(1000);
        connection.setReadTimeout(1500);
        connection.setUseCaches(false);
        try {
            if (connection.getResponseCode() != 200) throw new java.io.IOException("HTTP " + connection.getResponseCode());
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                while (bytes.size() < limit) {
                    int count = input.read(buffer, 0, Math.min(buffer.length, limit - bytes.size()));
                    if (count == -1) break;
                    bytes.write(buffer, 0, count);
                }
                return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally { connection.disconnect(); }
    }

    private void launchServer() {
        if (checkSelfPermission(TERMUX_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            busy = false;
            progress.setVisibility(View.GONE);
            status.setText("需要允许猫画布在 Termux 中执行启动命令。");
            requestPermissions(new String[]{TERMUX_PERMISSION}, 42);
            return;
        }
        Intent command = new Intent("com.termux.RUN_COMMAND");
        command.setComponent(new ComponentName("com.termux", "com.termux.app.RunCommandService"));
        command.putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash");
        command.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{START_SCRIPT, "--no-wait-on-error"});
        command.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
        command.putExtra("com.termux.RUN_COMMAND_BACKGROUND", false);
        command.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
        command.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "猫画布服务器");
        String requestId = Long.toHexString(SystemClock.elapsedRealtimeNanos());
        Intent result = new Intent(this, CommandResultReceiver.class);
        result.setAction(getPackageName() + ".COMMAND_RESULT." + requestId);
        result.putExtra("requestId", requestId);
        PendingIntent callback = PendingIntent.getBroadcast(this, 0, result,
                PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE);
        command.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", callback);
        try {
            // An explicit activity launch also wakes Termux on ROMs that defer cold service starts.
            Intent wake = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            wake.setComponent(new ComponentName("com.termux", "com.termux.app.TermuxActivity"));
            wake.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(wake);
            ComponentName service = startForegroundService(command);
            if (service == null) { error("未能连接 Termux，请打开 Termux 后重试。", false); return; }
            Log.i(TAG, "Woke Termux and requested server; waiting for readiness");
            status.setText("已唤醒 Termux，正在等待服务器启动…");
            awaitServer(++attempt, requestId);
        } catch (ActivityNotFoundException e) {
            callback.cancel();
            error("请先安装并打开一次 Termux。", false);
        } catch (SecurityException e) {
            callback.cancel();
            Log.e(TAG, "Termux permission denied", e);
            error("Termux 未允许启动命令。请检查猫画布的 Termux 执行权限和 Termux 外部应用设置。", true);
        } catch (RuntimeException e) {
            callback.cancel();
            Log.e(TAG, "Termux launch failed", e);
            error("无法启动 Termux：" + e.getMessage(), false);
        }
    }

    private void awaitServer(int currentAttempt, String requestId) {
        worker.execute(() -> {
            long deadline = SystemClock.elapsedRealtime() + START_TIMEOUT_MS;
            do {
                if (Thread.currentThread().isInterrupted()) return;
                if (serverReady()) {
                    runOnUiThread(() -> {
                        if (currentAttempt != attempt || isFinishing() || isDestroyed()) return;
                        Log.i(TAG, "Server ready after Termux wake");
                        // The Termux script opens the browser while it owns the foreground.
                        // Only open it here if this launcher is still visible.
                        if (resumed) openBrowser();
                        else finish();
                    });
                    return;
                }
                android.content.SharedPreferences results = getSharedPreferences("command-results", MODE_PRIVATE);
                if (requestId.equals(results.getString("requestId", ""))) {
                    String failure = results.getString("error", "启动脚本已经退出，服务器没有响应。");
                    runOnUiThread(() -> {
                        if (currentAttempt == attempt && !isFinishing() && !isDestroyed()) error(failure, false);
                    });
                    return;
                }
                try { Thread.sleep(400); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
            } while (SystemClock.elapsedRealtime() < deadline);
            runOnUiThread(() -> {
                if (currentAttempt != attempt || isFinishing() || isDestroyed()) return;
                Log.w(TAG, "Timed out waiting for Termux server");
                error("等待服务器超过 45 秒。请打开 Termux 查看猫画布启动提示，或重试。", false);
            });
        });
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == 42) {
            if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) start();
            else error("请在猫画布的应用权限中允许在 Termux 中执行命令。", true);
        }
    }

    private void openBrowser() {
        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(PAGE));
            browser.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(browser);
            finish();
        } catch (ActivityNotFoundException e) { error("没有可用的浏览器，请安装浏览器后重试。", false); }
    }

    private void openTermux() {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setComponent(new ComponentName("com.termux", "com.termux.app.TermuxActivity"));
        try { startActivity(intent); }
        catch (ActivityNotFoundException e) { error("请先安装并打开一次 Termux。", false); }
    }

    private void error(String message, boolean settings) {
        busy = false;
        settingsRequired = settings;
        progress.setVisibility(View.GONE);
        status.setText(message);
        retry.setText(settings ? "打开权限设置" : "重试");
        retry.setVisibility(View.VISIBLE);
    }

    @Override protected void onDestroy() {
        attempt++;
        worker.shutdownNow();
        super.onDestroy();
    }
}
