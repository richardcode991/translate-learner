// 面板逻辑：翻译展示、深度讲解、生词本、复习
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    orig: $('orig-text'), trans: $('trans-text'), dict: $('dict-box'),
    deepText: $('deep-text'), deepLoading: $('deep-loading'), deepError: $('deep-error'),
    btnDeep: $('btn-deep'), btnSave: $('btn-save'), btnSpeakOrig: $('btn-speak-orig'),
    vocabList: $('vocab-list'), vocabCount: $('vocab-count'), vocabEmpty: $('vocab-empty'),
    vocabSearch: $('vocab-search'),
    reviewCard: $('review-card'), reviewEmpty: $('review-empty'), reviewProgress: $('review-progress'),
    reviewContext: $('review-context'), reviewWord: $('review-word'),
    reviewAnswer: $('review-answer'), reviewTrans: $('review-trans'),
    btnShowAnswer: $('btn-show-answer'), gradeButtons: $('grade-buttons'),
    btnSpeakReview: $('btn-speak-review'),
    btnSettings: $('btn-settings'), chkEnabled: $('chk-enabled'),
    btnBilingual: $('btn-bilingual'),
    inBaseurl: $('in-baseurl'), inApikey: $('in-apikey'), inModel: $('in-model'),
    inTenId: $('in-ten-id'), inTenKey: $('in-ten-key'),
    inBaiduId: $('in-baidu-id'), inBaiduKey: $('in-baidu-key'),
    inBaiduTtsId: $('in-baidu-tts-id'), inBaiduTtsKey: $('in-baidu-tts-key'),
    btnSaveSettings: $('btn-save-settings')
  };

  const DEFAULTS = {
    enabled: true, triggerMode: 'auto', llmEngine: 'openai',
    llmBaseURL: 'https://api.deepseek.com', llmApiKey: '', llmModel: 'deepseek-chat',
    translateEngine: 'google',
    tencentSecretId: '', tencentSecretKey: '',
    baiduAppId: '', baiduSecretKey: '',
    ttsEngine: 'google',
    baiduTtsApiKey: '', baiduTtsSecretKey: ''
  };

  let current = null;       // 当前翻译结果 { original, translation, dict, context }
  let settings = { ...DEFAULTS };
  let vocab = [];
  let reviewQueue = [];
  let reviewCardData = null;

  // ---------- Tab 切换 ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'vocab') renderVocab();
      if (tab.dataset.tab === 'review') startReview();
    });
  });

  els.btnSettings.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.remove('active'));
    $('tab-settings').classList.add('active');
    fillSettingsForm();
  });

  // ---------- 双语对照模式 ----------
  function setBiState(on) {
    els.btnBilingual.textContent = on ? '双语·开' : '双语';
    els.btnBilingual.classList.toggle('bi-on', !!on);
    els.btnBilingual.title = on
      ? '双语对照已开启，点击关闭'
      : '双语对照模式：网页段落下插入中文翻译';
  }
  els.btnBilingual.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'BILINGUAL_TOGGLE' });
      if (res && res.ok) setBiState(res.enabled);
    } catch {
      // 当前页面不支持（如 chrome:// 内部页、商店页）
      els.btnBilingual.textContent = '双语✕';
      setTimeout(() => setBiState(false), 1200);
    }
  });
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'BILINGUAL_STATE' });
      if (res && res.ok) setBiState(res.enabled);
    } catch {
      setBiState(false);
    }
  })();

  // ---------- 初始化 ----------
  async function init() {
    const { settings: s, vocab: v, latest } = await chrome.storage.local.get(['settings', 'vocab', 'latest']);
    settings = { ...DEFAULTS, ...(s || {}) };
    vocab = v || [];
    updateVocabCount();
    if (latest) renderTranslation(latest);
  }

  // 收到新的翻译结果（实时广播 + storage 兜底）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TRANSLATED') renderTranslation(msg.data);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.latest && document.hidden) renderTranslation(changes.latest.newValue);
    if (changes.vocab) {
      vocab = changes.vocab.newValue || [];
      updateVocabCount();
    }
  });

  // ---------- 翻译展示 ----------
  function renderTranslation(data) {
    // 重置讲解区与错误态
    els.deepText.classList.add('hidden');
    els.deepText.textContent = '';
    els.deepError.classList.add('hidden');
    els.deepLoading.classList.add('hidden');
    els.btnDeep.disabled = false;
    els.btnDeep.textContent = '生成讲解';
    els.trans.classList.remove('error');
    els.dict.classList.add('hidden');

    if (data.error) {
      current = null;
      els.orig.textContent = data.original;
      els.trans.textContent =
        '翻译失败：' + data.error + '。若在国内网络环境，请检查代理；或在设置中将讲解引擎切换为「豆包网页版」（免代理）。';
      els.trans.classList.add('error');
      setSaveState(false);
      return;
    }

    current = data;
    els.orig.textContent = data.original;
    els.trans.textContent = data.translation || '（无翻译结果）';
    els.dict.innerHTML = '';
    if (data.dict && data.dict.length) {
      data.dict.forEach((d) => {
        const div = document.createElement('div');
        div.className = 'dict-item';
        const b = document.createElement('b');
        b.textContent = d.pos + ': ';
        div.appendChild(b);
        div.appendChild(document.createTextNode((d.terms || []).join('、')));
        els.dict.appendChild(div);
      });
      els.dict.classList.remove('hidden');
    } else {
      els.dict.classList.add('hidden');
    }
    // 重置收藏按钮
    const saved = vocab.some((w) => w.text.toLowerCase() === data.original.toLowerCase());
    setSaveState(saved);
  }

  // ---------- 朗读（统一经 SW：引擎可选 + 自动兜底，最终回退系统语音） ----------
  let speakAbort = null;
  function speakSystem(t) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'en-US';
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function speak(text) {
    if (!text) return;
    if (speakAbort) {
      speakAbort();
      speakAbort = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    const t = text.replace(/\s+/g, ' ').trim();
    if ((settings.ttsEngine || 'google') === 'system') return speakSystem(t);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TTS', text: t });
      if (res && res.ok && res.audioBase64List && res.audioBase64List.length) {
        const parts = res.audioBase64List.map(base64ToBytes);
        const url = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }));
        const audio = new Audio(url);
        speakAbort = () => {
          audio.pause();
          URL.revokeObjectURL(url);
        };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          speakAbort = null;
        };
        await audio.play();
      } else {
        speakSystem(t);
      }
    } catch (e) {
      speakSystem(t);
    }
  }
  els.btnSpeakOrig.addEventListener('click', () => speak(current && current.original));
  els.btnSpeakReview.addEventListener('click', () => speak(reviewCardData && reviewCardData.text));

  // ---------- 深度讲解 ----------
  els.btnDeep.addEventListener('click', async () => {
    if (!current) return;
    els.btnDeep.disabled = true;
    els.deepError.classList.add('hidden');
    els.deepText.classList.add('hidden');
    els.deepLoading.classList.remove('hidden');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'DEEP', original: current.original, context: current.context
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '讲解生成失败');
      els.deepLoading.classList.add('hidden');
      els.deepText.textContent = res.content;
      els.deepText.classList.remove('hidden');
      // 讲解随生词本保存：若该词已收藏则同步更新，未收藏则在收藏时带上
      if (current) {
        current.deep = res.content;
        const item = vocab.find((w) => w.text.toLowerCase() === current.original.toLowerCase());
        if (item && item.deep !== res.content) {
          item.deep = res.content;
          await chrome.storage.local.set({ vocab });
        }
      }
    } catch (e) {
      els.deepLoading.classList.add('hidden');
      els.deepError.textContent = e.message;
      els.deepError.classList.remove('hidden');
    } finally {
      els.btnDeep.disabled = false;
    }
  });

  // ---------- 生词本 ----------
  function setSaveState(saved) {
    els.btnSave.textContent = saved ? '★ 已在生词本中' : '☆ 收藏到生词本';
    els.btnSave.classList.toggle('saved', saved);
  }

  els.btnSave.addEventListener('click', async () => {
    if (!current) return;
    const exists = vocab.some((w) => w.text.toLowerCase() === current.original.toLowerCase());
    if (exists) {
      vocab = vocab.filter((w) => w.text.toLowerCase() !== current.original.toLowerCase());
      setSaveState(false);
    } else {
      vocab.unshift({
        id: Date.now(),
        text: current.original,
        translation: current.translation,
        context: current.context,
        deep: current.deep || '',
        sourceUrl: '',
        createdAt: Date.now(),
        review: { level: 0, lastReviewed: 0 }
      });
      setSaveState(true);
    }
    await chrome.storage.local.set({ vocab });
    updateVocabCount();
  });

  function updateVocabCount() {
    els.vocabCount.textContent = vocab.length ? String(vocab.length) : '';
  }

  function renderVocab() {
    const kw = (els.vocabSearch.value || '').trim().toLowerCase();
    const list = vocab.filter(
      (w) => !kw || w.text.toLowerCase().includes(kw) || (w.translation || '').toLowerCase().includes(kw)
    );
    els.vocabList.innerHTML = '';
    els.vocabEmpty.classList.toggle('hidden', list.length > 0);
    list.forEach((w) => {
      const li = document.createElement('li');
      li.className = 'vocab-item';
      const main = document.createElement('div');
      const word = document.createElement('div');
      word.className = 'vocab-word';
      word.textContent = w.text;
      if (w.deep) {
        const mark = document.createElement('span');
        mark.textContent = ' 📖';
        mark.title = '含深度讲解';
        word.appendChild(mark);
      }
      const tr = document.createElement('div');
      tr.className = 'vocab-trans';
      tr.textContent = (w.translation || '').slice(0, 60);
      main.appendChild(word);
      main.appendChild(tr);
      const del = document.createElement('button');
      del.className = 'vocab-del';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        vocab = vocab.filter((x) => x.id !== w.id);
        await chrome.storage.local.set({ vocab });
        updateVocabCount();
        renderVocab();
      });
      li.appendChild(main);
      li.appendChild(del);
      li.addEventListener('click', () => {
        renderTranslation({
          original: w.text, translation: w.translation, dict: [], context: w.context
        });
        // 回看已保存的深度讲解（不重新请求 LLM）
        if (w.deep) {
          current.deep = w.deep;
          els.deepText.textContent = w.deep;
          els.deepText.classList.remove('hidden');
          els.btnDeep.textContent = '重新生成讲解';
        }
        document.querySelector('.tab[data-tab="translate"]').click();
      });
      els.vocabList.appendChild(li);
    });
  }
  els.vocabSearch.addEventListener('input', renderVocab);

  // ---------- 复习 ----------
  async function startReview() {
    // 排序：掌握程度低优先，最久未复习优先
    reviewQueue = [...vocab].sort((a, b) => {
      const la = (a.review && a.review.level) || 0;
      const lb = (b.review && b.review.level) || 0;
      if (la !== lb) return la - lb;
      const ta = (a.review && a.review.lastReviewed) || a.createdAt || 0;
      const tb = (b.review && b.review.lastReviewed) || b.createdAt || 0;
      return ta - tb;
    });
    els.reviewProgress.textContent = '';
    nextReviewCard();
  }

  function nextReviewCard() {
    els.reviewAnswer.classList.add('hidden');
    els.gradeButtons.classList.add('hidden');
    els.btnShowAnswer.classList.remove('hidden');
    if (!reviewQueue.length) {
      els.reviewCard.classList.add('hidden');
      els.reviewEmpty.classList.remove('hidden');
      els.reviewProgress.textContent = vocab.length ? '本轮复习完成！' : '';
      return;
    }
    els.reviewEmpty.classList.add('hidden');
    els.reviewCard.classList.remove('hidden');
    reviewCardData = reviewQueue[0];
    els.reviewWord.textContent = reviewCardData.text;
    els.reviewContext.textContent = reviewCardData.context
      ? '…' + reviewCardData.context.slice(0, 80) + '…' : '';
    els.reviewTrans.textContent = reviewCardData.translation || '';
    els.reviewProgress.textContent = `剩余 ${reviewQueue.length} / 共 ${vocab.length} 个生词`;
  }

  els.btnShowAnswer.addEventListener('click', () => {
    els.reviewAnswer.classList.remove('hidden');
    els.btnShowAnswer.classList.add('hidden');
    els.gradeButtons.classList.remove('hidden');
  });

  els.gradeButtons.addEventListener('click', async (e) => {
    const btn = e.target.closest('.grade-btn');
    if (!btn || !reviewCardData) return;
    const grade = Number(btn.dataset.grade);
    // level: 0=不认识 1=模糊 2=认识(升级) 3=已熟练
    const item = vocab.find((w) => w.id === reviewCardData.id);
    if (item) {
      const cur = (item.review && item.review.level) || 0;
      const level = grade === 0 ? 0 : grade === 1 ? cur : Math.min(cur + 1, 3);
      item.review = { level, lastReviewed: Date.now() };
      await chrome.storage.local.set({ vocab });
      updateVocabCount();
    }
    reviewQueue.shift();
    nextReviewCard();
  });

  // ---------- 设置 ----------
  async function fillSettingsForm() {
    ({ settings } = await loadSettings());
    document.querySelector(`input[name="trigger"][value="${settings.triggerMode}"]`).checked = true;
    document.querySelector(`input[name="engine"][value="${settings.llmEngine}"]`).checked = true;
    document.querySelector(`input[name="tengine"][value="${settings.translateEngine}"]`).checked = true;
    document.querySelector(`input[name="sengine"][value="${settings.ttsEngine}"]`).checked = true;
    els.chkEnabled.checked = settings.enabled;
    els.inBaseurl.value = settings.llmBaseURL;
    els.inApikey.value = settings.llmApiKey;
    els.inModel.value = settings.llmModel;
    els.inTenId.value = settings.tencentSecretId;
    els.inTenKey.value = settings.tencentSecretKey;
    els.inBaiduId.value = settings.baiduAppId;
    els.inBaiduKey.value = settings.baiduSecretKey;
    els.inBaiduTtsId.value = settings.baiduTtsApiKey;
    els.inBaiduTtsKey.value = settings.baiduTtsSecretKey;
    toggleEngineFields();
    toggleTengineFields();
    toggleSengineFields();
  }
  function toggleEngineFields() {
    const engine = document.querySelector('input[name="engine"]:checked');
    const isDoubao = engine && engine.value === 'doubao';
    document.getElementById('openai-fields').classList.toggle('hidden', isDoubao);
  }
  function toggleTengineFields() {
    const te = document.querySelector('input[name="tengine"]:checked');
    const v = te ? te.value : 'google';
    document.getElementById('tencent-fields').classList.toggle('hidden', v !== 'tencent');
    document.getElementById('baidu-fields').classList.toggle('hidden', v !== 'baidu');
  }
  function toggleSengineFields() {
    const se = document.querySelector('input[name="sengine"]:checked');
    const v = se ? se.value : 'google';
    document.getElementById('baidu-tts-fields').classList.toggle('hidden', v !== 'baidu');
  }
  document.querySelectorAll('input[name="engine"]').forEach((r) =>
    r.addEventListener('change', toggleEngineFields)
  );
  document.querySelectorAll('input[name="tengine"]').forEach((r) =>
    r.addEventListener('change', toggleTengineFields)
  );
  document.querySelectorAll('input[name="sengine"]').forEach((r) =>
    r.addEventListener('change', toggleSengineFields)
  );
  async function loadSettings() {
    const { settings: s } = await chrome.storage.local.get('settings');
    return { settings: { ...DEFAULTS, ...(s || {}) } };
  }

  els.btnSaveSettings.addEventListener('click', async () => {
    const trigger = document.querySelector('input[name="trigger"]:checked');
    const engine = document.querySelector('input[name="engine"]:checked');
    const tengine = document.querySelector('input[name="tengine"]:checked');
    const sengine = document.querySelector('input[name="sengine"]:checked');
    settings = {
      ...settings,
      enabled: els.chkEnabled.checked,
      triggerMode: trigger ? trigger.value : 'auto',
      llmEngine: engine ? engine.value : 'openai',
      llmBaseURL: els.inBaseurl.value.trim() || DEFAULTS.llmBaseURL,
      llmApiKey: els.inApikey.value.trim(),
      llmModel: els.inModel.value.trim() || DEFAULTS.llmModel,
      translateEngine: tengine ? tengine.value : 'google',
      tencentSecretId: els.inTenId.value.trim(),
      tencentSecretKey: els.inTenKey.value.trim(),
      baiduAppId: els.inBaiduId.value.trim(),
      baiduSecretKey: els.inBaiduKey.value.trim(),
      ttsEngine: sengine ? sengine.value : 'google',
      baiduTtsApiKey: els.inBaiduTtsId.value.trim(),
      baiduTtsSecretKey: els.inBaiduTtsKey.value.trim()
    };
    await chrome.storage.local.set({ settings });
    els.btnSaveSettings.textContent = '已保存 ✓';
    setTimeout(() => (els.btnSaveSettings.textContent = '保存设置'), 1500);
  });

  init();
})();
