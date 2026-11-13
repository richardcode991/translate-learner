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
    'script, style, noscript, svg, .tl-bi-ext, ' +
    // 广告相关容器不翻译
    '[class*="advert"], [id*="advert"], [class*="sponsor"], [class*="promo"], ' +
    '[class*="browsi"], [id^="google_ads"], [class*="ad-entity"], [class*="programtic"]';
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
    `border-radius:0 6px 6px 0;white-space:pre-wrap;word-break:break-word;` +
    // 抬到站点隐形覆盖链接（如 Google News 整卡铺满的空 <a>）之上，
    // 否则点击译文/朗读按钮会被覆盖层截走触发跳转
    `position:relative;z-index:1;}` +
    `.tl-bi-speak{border:none;background:transparent;cursor:pointer;` +
    `font-size:.9em;opacity:.55;padding:0 4px;vertical-align:baseline;}` +
    `.tl-bi-speak:hover{opacity:1;}`;
  document.documentElement.appendChild(style);

  // 行内元素：段内的 a/span/b/em 等不应独立成块，需并入所在段落一起翻译
  const INLINE_TAGS = new Set(
    ('A SPAN B STRONG EM I U S SMALL SUB SUP TIME MARK ABBR CITE Q LABEL ' +
      'FONT BIG DEL INS DATA BDI BDO OUTPUT TT VAR WBR RUBY RT RP').split(' ')
  );

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
        // 跳过不可见文本（display:none 等）：只翻译当前所见，
        // 折叠/展开类交互（如 "see more"）展开后再补翻新可见部分
        if (!el.getClientRects().length) return NodeFilter.FILTER_REJECT;
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
      // 向上爬到文本边界：最外层且完整内容恰好等于该文本的祖先。
      // 保留完整祖先链：若最外层等值祖先是容器（含块级子元素，如
      // <div class="desc"><p>正文</p></div>），不能选它——否则容器被
      // isTranslatable 跳过后内层块永远漏译。应取链上最外层的非容器元素
      const base = norm(el.textContent);
      const chain = [el];
      let p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.closest(SKIP_SEL)) break;
        if (norm(p.textContent) === base) {
          chain.push(p);
          p = p.parentElement;
        } else {
          break;
        }
      }
      let target = chain[0];
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!chain[i].querySelector(BLOCK_CHILDREN)) {
          target = chain[i];
          break;
        }
      }
      // 行内元素（如段内 <a>）并入其所在的块级段落，避免译文插进句子中间
      if (INLINE_TAGS.has(target.tagName)) {
        let b = target.parentElement;
        while (b && INLINE_TAGS.has(b.tagName) && b !== document.body) {
          b = b.parentElement;
        }
        if (
          b &&
          b !== document.body &&
          b !== document.documentElement &&
          !b.dataset.tlBi &&
          !b.querySelector(BLOCK_CHILDREN) &&
          !b.closest(SKIP_SEL)
        ) {
          targets.add(b);
          continue;
        }
        // 所在段落已翻译或不可用（如 "see more" 展开场景）：
        // 行内元素保持独立成块，展开的新文本可单独补翻
      }
      targets.add(target);
    }
    const out = [];
    for (const el of targets) {
      if (!el.dataset.tlQueued && isTranslatable(el)) out.push(el);
    }
    return out;
  }

  // 翻译队列（并发 4）+ 页面级已翻译文本去重
  // （同一段原文被两级候选选中时——如网站脚本延迟把文本包进容器，
  //  figure 和 figcaption 先后被扫描——只出一份译文）
  const queue = [];
  const translatedTexts = new Set();
  let running = 0;
  function enqueue(el) {
    if (el.dataset.tlQueued) return;
    const key = norm(el.textContent);
    if (translatedTexts.has(key)) {
      el.dataset.tlBi = 'skip'; // 同原文已有译文，标记跳过
      return;
    }
    el.dataset.tlQueued = '1'; // 入队即标记，防止 MutationObserver 重扫导致重复
    translatedTexts.add(key);
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
      if (!res || !res.ok || !res.translation) {
        // 翻译失败：释放去重键，后续重扫可再次尝试
        translatedTexts.delete(norm(el.textContent));
        return;
      }
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
      // 站点级事件委托（如 Google News 的 jsaction，整卡 <a> 包裹）会
      // 把按钮点击当成卡片点击触发跳转：拦截按钮上全部鼠标事件的冒泡
      for (const evt of ['pointerdown', 'mousedown', 'mouseup', 'auxclick']) {
        btn.addEventListener(evt, (e) => {
          e.stopPropagation();
          e.preventDefault();
        });
      }
      div.appendChild(btn);
      // 译文块整体拦截事件冒泡：防止站点级委托（Google News 的 jsaction
      // 卡片点击）把对译文区域的点击当成卡片点击触发跳转。
      // 注意不 preventDefault（保留文本选择能力），拦截交给按钮自己
      for (const evt of ['click', 'pointerdown', 'mousedown', 'mouseup', 'auxclick']) {
        div.addEventListener(evt, (e) => e.stopPropagation());
      }
      if (INNER_TAGS.has(el.tagName) && !el.closest('a[href]')) {
        // 表格单元格/列表项：插入到内部，避免破坏结构
        el.appendChild(div);
      } else {
        // ① 块在链接内部时优先插到链接外，避免点击触发跳转；
        // ② 但插入点的父级若是 flex/grid（如 GitHub topics 的卡片行），
        //    译文会成为被挤压的 flex 子项（左右排列、文字挤扁），
        //    此时改插到元素内部，保持上下布局
        let at = el;
        const anchor = el.closest('a[href]');
        if (anchor && anchor !== el) {
          const pd = anchor.parentElement
            ? getComputedStyle(anchor.parentElement).display
            : 'block';
          if (!/^(inline-)?(flex|grid)/.test(pd)) at = anchor;
        }
        const atParent = at.parentElement;
        const pd2 = atParent ? getComputedStyle(atParent).display : 'block';
        if (/^(inline-)?(flex|grid)/.test(pd2)) {
          el.appendChild(div);
        } else {
          at.insertAdjacentElement('afterend', div);
        }
      }
      el.dataset.tlBi = '1';
    } catch {
      // 静默忽略单个块失败
    }
  }

  function apply(on) {
    enabled = on;
    if (on) {
      collectCandidates(document.body).forEach(enqueue);
      // 累积 mutation 涉及的根节点，防抖后统一重扫
      // （回调里的 muts 数组每批独立，直接在回调里防抖会丢失前几批的节点）
      const pendingRoots = new Set();
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 3) {
              if (n.parentElement) pendingRoots.add(n.parentElement);
            } else if (n.nodeType === 1) {
              if (n.classList && n.classList.contains(CLS)) continue;
              pendingRoots.add(n);
            }
          }
          // style/class/hidden 属性变化（如 "see more" 展开隐藏文本）：
          // 变为可见的内容需要补翻
          if (m.type === 'attributes' && m.target.nodeType === 1) {
            pendingRoots.add(m.target);
          }
        }
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
          if (!enabled) return;
          for (const r of pendingRoots) {
            collectCandidates(r).forEach((el) => {
              if (!el.dataset.tlBi) enqueue(el);
            });
          }
          pendingRoots.clear();
        }, 600);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      });
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
      translatedTexts.clear();
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
