// Preserve the original experience as a visual reference while developing music mode.

// ── 桌面端引导（Electron）────────────────────────────────────────
// 必须在切换视图之前完成：动效设置要在首屏渲染前落到 CSS 变量上，
// 否则会出现「先用默认动效渲染一帧，再切成用户设置」的闪一下。
// 浏览器里打开（无 window.rhine）时这段自动跳过，不影响上游 Web 版。
void (async () => {
  const api = typeof window === "undefined" ? undefined : window.rhine;
  if (api) {
    try {
      const [{ motion }, desktop] = await Promise.all([
        import("@desktop/motion.js"),
        import("@desktop/desktop-ui.js"),
      ]);
      // 同步可得的启动信息（preload 在页面脚本之前执行）
      const persisted = api.startup?.settings?.motion;
      if (persisted) motion.apply(persisted);
      desktop.bootDesktop();
    } catch (error) {
      // 桌面集成失败不应让整个应用白屏，退回上游 Web 行为
      console.error("[desktop] 初始化失败，回退到基础模式:", error);
    }
  }

  if (new URLSearchParams(location.search).get("original") === "1") {
    void import("./archive-main");
  } else {
    void import("./music-app");
  }
})();
