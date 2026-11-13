const DEFAULTS = {
  enabled: true, triggerMode: 'auto', llmEngine: 'openai',
  llmBaseURL: 'https://api.deepseek.com', llmApiKey: '', llmModel: 'deepseek-chat',
  translateEngine: 'google',
  tencentSecretId: '', tencentSecretKey: '',
  baiduAppId: '', baiduSecretKey: '',
  ttsEngine: 'google',
  baiduTtsApiKey: '', baiduTtsSecretKey: '',
  bilingualAuto: false
};

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  document.querySelector(`input[name="trigger"][value="${s.triggerMode}"]`).checked = true;
  document.querySelector(`input[name="engine"][value="${s.llmEngine}"]`).checked = true;
  document.querySelector(`input[name="tengine"][value="${s.translateEngine}"]`).checked = true;
  document.querySelector(`input[name="sengine"][value="${s.ttsEngine}"]`).checked = true;
  document
    .querySelector(`input[name="bimode"][value="${s.bilingualAuto ? 'auto' : 'manual'}"]`)
    .checked = true;
  document.getElementById('chk-enabled').checked = s.enabled;
  document.getElementById('in-baseurl').value = s.llmBaseURL;
  document.getElementById('in-apikey').value = s.llmApiKey;
  document.getElementById('in-model').value = s.llmModel;
  document.getElementById('in-ten-id').value = s.tencentSecretId;
  document.getElementById('in-ten-key').value = s.tencentSecretKey;
  document.getElementById('in-baidu-id').value = s.baiduAppId;
  document.getElementById('in-baidu-key').value = s.baiduSecretKey;
  document.getElementById('in-baidu-tts-id').value = s.baiduTtsApiKey;
  document.getElementById('in-baidu-tts-key').value = s.baiduTtsSecretKey;
  toggleEngineFields();
  toggleTengineFields();
  toggleSengineFields();
  document.querySelectorAll('input[name="engine"]').forEach((r) =>
    r.addEventListener('change', toggleEngineFields)
  );
  document.querySelectorAll('input[name="tengine"]').forEach((r) =>
    r.addEventListener('change', toggleTengineFields)
  );
  document.querySelectorAll('input[name="sengine"]').forEach((r) =>
    r.addEventListener('change', toggleSengineFields)
  );
})();

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

document.getElementById('btn-save').addEventListener('click', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const trigger = document.querySelector('input[name="trigger"]:checked');
  const engine = document.querySelector('input[name="engine"]:checked');
  const tengine = document.querySelector('input[name="tengine"]:checked');
  const sengine = document.querySelector('input[name="sengine"]:checked');
  const bimode = document.querySelector('input[name="bimode"]:checked');
  const next = {
    ...(settings || {}),
    enabled: document.getElementById('chk-enabled').checked,
    triggerMode: trigger ? trigger.value : 'auto',
    llmEngine: engine ? engine.value : 'openai',
    llmBaseURL: document.getElementById('in-baseurl').value.trim() || DEFAULTS.llmBaseURL,
    llmApiKey: document.getElementById('in-apikey').value.trim(),
    llmModel: document.getElementById('in-model').value.trim() || DEFAULTS.llmModel,
    translateEngine: tengine ? tengine.value : 'google',
    tencentSecretId: document.getElementById('in-ten-id').value.trim(),
    tencentSecretKey: document.getElementById('in-ten-key').value.trim(),
    baiduAppId: document.getElementById('in-baidu-id').value.trim(),
    baiduSecretKey: document.getElementById('in-baidu-key').value.trim(),
    ttsEngine: sengine ? sengine.value : 'google',
    baiduTtsApiKey: document.getElementById('in-baidu-tts-id').value.trim(),
    baiduTtsSecretKey: document.getElementById('in-baidu-tts-key').value.trim(),
    bilingualAuto: bimode ? bimode.value === 'auto' : false
  };
  await chrome.storage.local.set({ settings: next });
  document.getElementById('save-tip').textContent = '已保存 ✓';
  setTimeout(() => (document.getElementById('save-tip').textContent = ''), 1500);
});
