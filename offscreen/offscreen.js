// Offscreen 播放页：在独立上下文播放 TTS 音频，
// 不受各网站页面 CSP 的 media-src 限制（GitHub 等站点会拦截 blob: 媒体）
(() => {
  let audio = null;
  let url = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OFFSCREEN_PLAY') {
      play(msg.audioBase64List || []);
    } else if (msg.type === 'OFFSCREEN_STOP') {
      stop();
    }
  });

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function stop() {
    if (audio) {
      audio.pause();
      audio = null;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
  }

  async function play(base64List) {
    stop();
    if (!base64List.length) return;
    try {
      const parts = base64List.map(b64ToBytes);
      url = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }));
      audio = new Audio(url);
      audio.onended = () => {
        stop();
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ENDED' }).catch(() => {});
      };
      audio.onerror = () => {
        stop();
        chrome.runtime
          .sendMessage({ type: 'OFFSCREEN_ERROR', error: 'audio decode error' })
          .catch(() => {});
      };
      await audio.play();
    } catch (e) {
      stop();
      chrome.runtime
        .sendMessage({ type: 'OFFSCREEN_ERROR', error: (e && e.message) || String(e) })
        .catch(() => {});
    }
  }
})();
