// Content Script：划词检测（selectionchange + 防抖）
(() => {
  // 扩展重载/更新后，旧标签页里的内容脚本上下文会失效（Extension context invalidated），
  // 此时任何 chrome.* 调用都会抛错。这里统一检测，失效则静默退出（刷新页面后自动恢复）。
  const ctxAlive = () => {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };
  if (!ctxAlive()) return;

  let timer = null;
  let altPressed = false;
  let settings = { enabled: true, triggerMode: 'auto' };

  try {
    chrome.storage.local.get('settings', ({ settings: s }) => {
      if (s) settings = { ...settings, ...s };
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        settings = { ...settings, ...(changes.settings.newValue || {}) };
      }
    });
  } catch {
    // 上下文失效时静默退出
    return;
  }

  // 用任意键盘事件同步 Alt/Option(⌥) 按键状态（Mac 上 Alt 即 Option 键）
  document.addEventListener('keydown', (e) => {
    altPressed = e.altKey || e.key === 'Alt';
  });
  document.addEventListener('keyup', (e) => {
    altPressed = e.altKey || e.key === 'Alt';
  });

  function getContext(sel) {
    // 取选区所在段落附近文本作为上下文（截断）
    try {
      const node = sel.anchorNode;
      if (!node) return '';
      const el = node.nodeType === 3 ? node.parentElement : node;
      if (!el) return '';
      const paragraph = el.closest('p, h1, h2, h3, h4, li, blockquote, td, div');
      const full = paragraph ? paragraph.innerText || '' : '';
      return full.replace(/\s+/g, ' ').slice(0, 500);
    } catch {
      return '';
    }
  }

  function isTranslatable(text) {
    if (!text || text.length < 1 || text.length > 2000) return false;
    const letters = text.match(/[A-Za-z]/g) || [];
    if (letters.length < 1) return false;
    // 英文字母占比需超过 40%（排除中文页面误选）
    return letters.length / text.length > 0.4;
  }

  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (!ctxAlive()) return;
        if (!settings.enabled) return;
        if (settings.triggerMode === 'alt' && !altPressed) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const text = sel.toString().replace(/\s+/g, ' ').trim();
        if (!isTranslatable(text)) return;
        chrome.runtime
          .sendMessage({
            type: 'SELECTION',
            text,
            context: getContext(sel)
          })
          .catch(() => {});
      } catch {
        // 上下文失效或其他异常，静默忽略
      }
    }, 350);
  });
})();
