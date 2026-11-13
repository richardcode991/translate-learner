// Content Script：双语对照阅读模式（段落下插入中文翻译）
// 选块策略：TreeWalker 遍历文本节点 → 向上爬到"文本边界"（最外层且内容恰好
// 等于该文本的祖先），不依赖固定标签清单，任意标签排版的正文均可覆盖
(() => {
  const ctxAlive = () => {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };
  if (!ctxAlive()) return;

  const CLS = 'tl-bi-ext';
  const SKIP_SEL =
    'pre, code, kbd, samp, nav, header, footer, button, [role="button"], ' +
    '[aria-hidden="true"], [contenteditable="true"], textarea, input, select, ' +
    'script, style, noscript, svg, .tl-bi-ext';
  // 这些块级子元素存在时，说明当前元素是容器而非文本块（交给子元素处理）
  const BLOCK_CHILDREN =
    'p, div, li, ul, ol, table, section, article, aside, h1, h2, h3, h4, h5, h6, ' +
    'blockquote, pre, figure, dl, dt, dd, main, form, video, canvas, svg, iframe';
  // 这些标签的译文插入到元素内部（插入到后面会破坏 HTML 结构）
  const INNER_TAGS = new Set(['TD', 'TH', 'LI', 'DD', 'DT', 'SUMMARY']);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  let enabled = false;
  let observer = null;
  let scanTimer = null;

  // 注入样式
  const style = document.createElement('style');
  style.textContent =
    `.${CLS}{margin:4px 0 10px;padding:2px 10px;border-left:3px solid #85b7eb;` +
    `color:#40556b;font-size:.92em;line-height:1.6;background:#f4f8fd;` +
    `border-radius:0 6px 6px 0;white-space:pre-wrap;word-break:break-word;}` +
    `.tl-bi-speak{border:none;background:transparent;cursor:pointer;` +
    `font-size:.9em;opacity:.55;padding:0 4px;vertical-align:baseline;}` +
    `.tl-bi-speak:hover{opacity:1;}`;
  document.documentElement.appendChild(style);

  function isTranslatable(el) {
    if (el.dataset.tlBi === '1' || el.dataset.tlBi === 'skip') return false;
    if (el === document.body || el === document.documentElement) return false;
    if (el.closest(SKIP_SEL)) return false;
    // 容器元素交给子元素处理
    if (el.querySelector(BLOCK_CHILDREN)) return false;
    const text = norm(el.innerText);
    if (text.length < 6 || text.length > 5000) return false;
    // 中文字符占比高则视为中文块（永久标记）；英文字母需占 30% 以上
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk / text.length > 0.25) {
      el.dataset.tlBi = 'skip';
      return false;
    }
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    if (letters / text.length < 0.3) return false;
    return true;
  }

  function collectCandidates(root) {
    const targets = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue || '';
        if (!/[A-Za-z]/.test(t)) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el || el.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let el = n.parentElement;
      // 混排容器（含块级子元素）中的散落文本节点：包一层 span 使其成为独立文本块
      if (el.querySelector(BLOCK_CHILDREN)) {
        if (norm(n.nodeValue).length < 6) continue; // 过短的散落文本不值得处理
        const wrap = document.createElement('span');
        el.insertBefore(wrap, n);
        wrap.appendChild(n);
        el = wrap;
      }
      // 向上爬到文本边界：最外层且完整内容恰好等于该文本的祖先
      const base = norm(el.textContent);
      let target = el;
      let p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.closest(SKIP_SEL)) break;
        if (norm(p.textContent) === base) {
          target = p;
          p = p.parentElement;
        } else {
          break;
        }
      }
      targets.add(target);
    }
    const out = [];
    for (const el of targets) {
      if (!el.dataset.tlQueued && isTranslatable(el)) out.push(el);
    }
    return out;
  }

  // 翻译队列（并发 4）
  const queue = [];
  let running = 0;
  function enqueue(el) {
    if (el.dataset.tlQueued) return;
    el.dataset.tlQueued = '1'; // 入队即标记，防止 MutationObserver 重扫导致重复
    queue.push(el);
    pump();
  }
  function pump() {
    while (running < 4 && queue.length) {
      const el = queue.shift();
      running++;
      translateEl(el).finally(() => {
        running--;
        pump();
      });
    }
  }

  // 全局只保留一个正在播放的音频（实际播放由 offscreen 页完成，
  // 页面 CSP（如 GitHub 的 media-src）会拦截内容脚本里的 blob: 媒体）
  let currentBtn = null;
  let speaking = false;

  function stopCurrent() {
    if (speaking) {
      chrome.runtime.sendMessage({ type: 'TTS_STOP' }).catch(() => {});
    }
    speaking = false;
    if (currentBtn) {
      currentBtn.textContent = '🔊';
      currentBtn.title = '朗读英文原文';
      currentBtn = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  async function speakOriginal(btn) {
    const text = btn.dataset.orig || '';
    if (!text) return;
    // 再次点击正在播放的按钮 = 停止
    if (currentBtn === btn && speaking) {
      stopCurrent();
      return;
    }
    stopCurrent();
    currentBtn = btn;
    btn.textContent = '⏳';
    const res = await chrome.runtime
      .sendMessage({ type: 'TTS_PLAY', text })
      .catch(() => null);
    if (res && res.ok) {
      speaking = true;
      btn.textContent = '⏸';
      btn.title = '正在朗读（' + (res.engine || '在线引擎') + '），点击停止';
    } else {
      // 失败：短暂 ⚠ 提示 + 系统语音兜底
      btn.textContent = '⚠';
      btn.title = res && res.error ? '在线朗读失败: ' + res.error : '在线朗读请求失败';
      if (res && res.error) console.warn('[双语朗读] 失败原因:', res.error);
      setTimeout(() => {
        if (btn.textContent === '⚠') btn.textContent = '🔊';
      }, 2000);
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        speechSynthesis.speak(u);
      }
    }
  }

  async function translateEl(el) {
    try {
      if (!el.isConnected || el.dataset.tlBi === '1') return;
      const text = norm(el.innerText);
      if (!text) return;
      const res = await chrome.runtime.sendMessage({ type: 'PARA', text }).catch(() => null);
      if (!res || !res.ok || !res.translation) return;
      if (!el.isConnected || el.dataset.tlBi === '1') return;
      const div = document.createElement('div');
      div.className = CLS;
      const span = document.createElement('span');
      span.textContent = res.translation;
      div.appendChild(span);
      // 朗读原文按钮
      const btn = document.createElement('button');
      btn.className = 'tl-bi-speak';
      btn.textContent = '🔊';
      btn.title = '朗读英文原文';
      btn.dataset.orig = text;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        speakOriginal(btn);
      });
      div.appendChild(btn);
      if (INNER_TAGS.has(el.tagName)) {
        // 表格单元格/列表项：插入到内部，避免破坏结构
        el.appendChild(div);
      } else {
        el.insertAdjacentElement('afterend', div);
      }
      el.dataset.tlBi = '1';
    } catch {
      // 静默忽略单个块失败
    }
  }

  function scanAddedNodes(muts) {
    const roots = new Set();
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) {
          if (n.parentElement) roots.add(n.parentElement);
        } else if (n.nodeType === 1) {
          if (n.classList && n.classList.contains(CLS)) continue;
          roots.add(n);
        }
      }
    }
    for (const r of roots) {
      collectCandidates(r).forEach((el) => {
        if (!el.dataset.tlBi) enqueue(el);
      });
    }
  }

  function apply(on) {
    enabled = on;
    if (on) {
      collectCandidates(document.body).forEach(enqueue);
      observer = new MutationObserver((muts) => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
          if (!enabled) return;
          scanAddedNodes(muts);
        }, 600);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      if (observer) observer.disconnect();
      observer = null;
      stopCurrent(); // 停掉正在播放的朗读
      document.querySelectorAll('.' + CLS).forEach((n) => n.remove());
      document.querySelectorAll('[data-tl-bi]').forEach((n) => delete n.dataset.tlBi);
      document
        .querySelectorAll('[data-tl-queued]')
        .forEach((n) => delete n.dataset.tlQueued);
      queue.length = 0;
    }
  }

  // 恢复上次的全局开关状态
  chrome.storage.local.get('bilingualEnabled', ({ bilingualEnabled }) => {
    if (bilingualEnabled && !enabled) apply(true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bilingualEnabled) {
      const v = !!changes.bilingualEnabled.newValue;
      if (v !== enabled) apply(v);
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.type === 'TTS_ENDED') {
        // offscreen 播放自然结束：复位按钮
        speaking = false;
        if (currentBtn) {
          currentBtn.textContent = '🔊';
          currentBtn.title = '朗读英文原文';
          currentBtn = null;
        }
      } else if (msg.type === 'TTS_ERROR') {
        speaking = false;
        if (currentBtn) {
          const btn = currentBtn;
          btn.textContent = '⚠';
          btn.title = '在线朗读失败: ' + (msg.error || '未知');
          setTimeout(() => {
            if (btn.textContent === '⚠') btn.textContent = '🔊';
          }, 2000);
          currentBtn = null;
        }
      } else if (msg.type === 'BILINGUAL_TOGGLE') {
        apply(!enabled);
        chrome.storage.local.set({ bilingualEnabled: enabled });
        sendResponse({ ok: true, enabled });
      } else if (msg.type === 'BILINGUAL_STATE') {
        sendResponse({ ok: true, enabled });
      }
    } catch {
      sendResponse({ ok: false });
    }
    return false;
  });
})();
