// Service Worker：消息路由、翻译引擎调用、缓存

const DEFAULT_SETTINGS = {
  enabled: true,
  triggerMode: 'auto', // auto | alt
  llmEngine: 'openai', // openai | doubao（豆包网页版免 Key）
  llmBaseURL: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-chat',
  translateEngine: 'google', // google | tencent | baidu
  tencentSecretId: '',
  tencentSecretKey: '',
  baiduAppId: '',
  baiduSecretKey: '',
  ttsEngine: 'google', // google | tencent | baidu | system
  baiduTtsApiKey: '',
  baiduTtsSecretKey: ''
};

const cache = new Map(); // text -> quick result
const CACHE_LIMIT = 200;

function cacheGet(key) {
  return cache.get(key);
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, value);
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------- 快译引擎（可插拔） ----------
async function quickTranslate(text, settings) {
  if (settings.translateEngine === 'tencent') return tencentTranslate(text, settings);
  if (settings.translateEngine === 'baidu') return baiduTranslate(text, settings);
  return googleTranslate(text);
}

// Google gtx 接口（免费、无需 Key，国内需代理）
// 免费接口对突发请求敏感（双语模式一次几十段会触发 429）：
// 请求间强制最小间隔 + 429 指数退避重试
let googleLastAt = 0;
const GOOGLE_MIN_INTERVAL = 160;
async function googleTranslate(text) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&dt=bd&dj=1&q=' +
    encodeURIComponent(text);
  const wait = googleLastAt + GOOGLE_MIN_INTERVAL - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  googleLastAt = Date.now();
  let res = await fetch(url);
  // 429：限流，退避重试最多 2 次（0.8s、1.6s，带抖动）
  for (let i = 0; i < 2 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 800 * (i + 1) + Math.random() * 400));
    googleLastAt = Date.now();
    res = await fetch(url);
  }
  if (res.status === 429) {
    throw new Error(
      'Google 免费翻译接口限流（429）。稍等十几秒再试；或在设置里把「快速翻译引擎」改为腾讯云 / 百度（国内直连、额度充足）'
    );
  }
  if (!res.ok) {
    throw new Error(
      '快译接口请求失败: ' +
        res.status +
        (res.status >= 500 ? '（Google 服务端异常，稍后重试）' : '')
    );
  }
  const data = await res.json();
  const translation = (data.sentences || []).map((s) => s.trans || '').join('');
  const dict = (data.dict || []).map((d) => ({
    pos: d.pos,
    terms: (d.terms || []).slice(0, 5)
  }));
  return { translation, dict };
}

// ---------- 腾讯云机器翻译（TC3-HMAC-SHA256 签名，国内直连） ----------
function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function hmacSha256(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
}
async function sha256Hex(msg) {
  return bufToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)));
}

async function tencentTranslate(text, s) {
  if (!s.tencentSecretId || !s.tencentSecretKey) {
    throw new Error('未配置腾讯云 SecretId/SecretKey，请到设置页填写');
  }
  const host = 'tmt.tencentcloudapi.com';
  const service = 'tmt';
  const action = 'TextTranslate';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({ SourceText: text, Source: 'en', Target: 'zh', ProjectId: 0 });
  const hashedPayload = await sha256Hex(payload);
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    'content-type;host;x-tc-action',
    hashedPayload
  ].join('\n');
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    `${date}/${service}/tc3_request`,
    await sha256Hex(canonicalRequest)
  ].join('\n');
  const kDate = await hmacSha256('TC3' + s.tencentSecretKey, date);
  const kService = await hmacSha256(kDate, service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  const signature = bufToHex(await hmacSha256(kSigning, stringToSign));
  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': '2018-03-21',
      'X-TC-Region': 'ap-guangzhou',
      'X-TC-Timestamp': String(timestamp),
      Authorization:
        `TC3-HMAC-SHA256 Credential=${s.tencentSecretId}/${date}/${service}/tc3_request, ` +
        'SignedHeaders=content-type;host;x-tc-action, Signature=' +
        signature
    },
    body: payload
  });
  const data = await res.json().catch(() => ({}));
  const err = data.Response && data.Response.Error;
  if (err) {
    throw new Error(`腾讯翻译错误 ${err.Code}: ${err.Message}`);
  }
  const translation = data.Response && data.Response.TargetText;
  if (!translation) throw new Error('腾讯翻译返回内容为空');
  return { translation, dict: [] };
}

// ---------- 百度翻译开放平台（MD5 签名，国内直连，标准版 QPS=1） ----------
// 紧凑版 MD5（RFC 1321），用于百度签名（WebCrypto 不支持 MD5）
function md5(str) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const utf8 = new TextEncoder().encode(str);
  const bitLen = utf8.length * 8;
  const padded = new Uint8Array((((utf8.length + 8) >> 6) + 1) * 64);
  padded.set(utf8);
  padded[utf8.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);
  // MD5 每轮用的是「循环左移」，写成右移会导致签名全错（百度 54001）
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true); out.setUint32(4, b0, true);
  out.setUint32(8, c0, true); out.setUint32(12, d0, true);
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let lastBaiduAt = 0;
// 错误码 → 可执行的中文提示
const BAIDU_ERR = {
  52001: '请求超时，稍后重试',
  52002: '系统错误，稍后重试',
  52003: 'APPID 未授权或填写有误，请核对百度翻译开放平台的 APPID',
  54000: '必填参数为空',
  54001: '签名错误：APPID 或密钥不正确。请确认二者来自同一个「通用翻译」应用，且没有多余空格/换行',
  54003: '请求过于频繁（标准版 QPS=1），请降低速度',
  54004: '账户余额不足',
  54005: '长文本请求过于频繁，请稍后重试',
  58000: '客户端 IP 不在白名单内，请在百度控制台关闭 IP 限制或加入当前 IP',
  58001: '语言方向不支持，检查源/目标语言',
  58002: '服务已关闭，请在百度控制台开通「通用翻译」'
};
async function baiduTranslate(text, s) {
  const appid = String(s.baiduAppId || '').trim();
  const key = String(s.baiduSecretKey || '').trim();
  if (!appid || !key) {
    throw new Error('未配置百度翻译 APPID/密钥，请到设置页填写');
  }
  const q = String(text).trim();
  if (!q) throw new Error('待翻译内容为空');
  // 标准版 QPS=1，串行限速避免 54003
  const wait = lastBaiduAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastBaiduAt = Date.now();
  const salt = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  // 签名规则：md5(appid + q + salt + 密钥)，q 必须与请求体里的原文完全一致
  const sign = md5(appid + q + salt + key);
  const res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q, from: 'en', to: 'zh', appid, salt, sign }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (data.error_code) {
    const code = String(data.error_code);
    const hint = BAIDU_ERR[code] || data.error_msg || '未知错误';
    throw new Error(`百度翻译错误 ${code}：${hint}`);
  }
  const translation = (data.trans_result || []).map((t) => t.dst).join('\n');
  if (!translation) throw new Error('百度翻译返回内容为空');
  return { translation, dict: [] };
}

// ---------- 语音合成 TTS（腾讯 / 百度，供面板经 SW 调用） ----------
function chunkTextS(t, max) {
  if (t.length <= max) return [t];
  const chunks = [];
  let cur = '';
  for (const word of t.split(' ')) {
    if ((cur + ' ' + word).trim().length > max) {
      chunks.push(cur.trim());
      cur = word;
    } else {
      cur = (cur + ' ' + word).trim();
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// Google 在线语音（与快译同域名，供面板和双语朗读按钮经 SW 调用）
async function googleTtsBytes(text) {
  const url =
    'https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
    encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('google tts HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  // 校验确实是音频：防止代理/风控返回 200 + HTML 错误页导致解码失败
  if (buf.length < 500 || !ct.includes('audio')) {
    throw new Error('google tts 返回非音频 content-type=' + ct + ' size=' + buf.length);
  }
  return bytesToBase64(buf);
}

// 按所选引擎合成；失败时自动兜底到已配置密钥的其他在线引擎
async function synthWithFallback(text, settings) {
  const engine = settings.ttsEngine || 'google';
  const chain = [engine];
  if (
    engine !== 'tencent' &&
    settings.tencentSecretId && settings.tencentSecretKey
  ) chain.push('tencent');
  if (
    engine !== 'baidu' &&
    settings.baiduTtsApiKey && settings.baiduTtsSecretKey
  ) chain.push('baidu');
  let lastErr = null;
  for (const eng of chain) {
    try {
      const max = eng === 'tencent' ? 140 : eng === 'baidu' ? 500 : 180;
      const list = [];
      for (const c of chunkTextS(text, max)) {
        if (eng === 'tencent') list.push(await tencentTts(c, settings));
        else if (eng === 'baidu') list.push(await baiduTts(c, settings));
        else list.push(await googleTtsBytes(c));
      }
      return { ok: true, audioBase64List: list, engine: eng };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: (lastErr && lastErr.message) || 'TTS 全部引擎失败' };
}

// 腾讯云语音合成（基础音色 101001，中英文混读，复用翻译的 SecretId/Key）
async function tencentTts(text, s) {
  if (!s.tencentSecretId || !s.tencentSecretKey) {
    throw new Error('未配置腾讯云 SecretId/SecretKey，请到设置页填写');
  }
  const host = 'tts.tencentcloudapi.com';
  const service = 'tts';
  const action = 'TextToVoice';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    Text: text,
    SessionId: crypto.randomUUID(),
    Volume: 0,
    Speed: 0,
    VoiceType: 101001,
    ModelType: 1,
    SampleRate: 16000,
    Codec: 'mp3'
  });
  const hashedPayload = await sha256Hex(payload);
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    'content-type;host;x-tc-action',
    hashedPayload
  ].join('\n');
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    `${date}/${service}/tc3_request`,
    await sha256Hex(canonicalRequest)
  ].join('\n');
  const kDate = await hmacSha256('TC3' + s.tencentSecretKey, date);
  const kService = await hmacSha256(kDate, service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  const signature = bufToHex(await hmacSha256(kSigning, stringToSign));
  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': '2019-08-23',
      'X-TC-Region': 'ap-guangzhou',
      'X-TC-Timestamp': String(timestamp),
      Authorization:
        `TC3-HMAC-SHA256 Credential=${s.tencentSecretId}/${date}/${service}/tc3_request, ` +
        'SignedHeaders=content-type;host;x-tc-action, Signature=' +
        signature
    },
    body: payload
  });
  const data = await res.json().catch(() => ({}));
  const err = data.Response && data.Response.Error;
  if (err) {
    throw new Error(`腾讯语音合成错误 ${err.Code}: ${err.Message}`);
  }
  const b64 = data.Response && data.Response.Audio;
  if (!b64) throw new Error('腾讯语音合成返回音频为空');
  return b64;
}

// 百度语音合成（REST API，需单独的 API Key/Secret Key）
async function baiduTtsToken(s) {
  const { baiduTtsToken, baiduTtsTokenExp } = await chrome.storage.local.get([
    'baiduTtsToken',
    'baiduTtsTokenExp'
  ]);
  if (baiduTtsToken && baiduTtsTokenExp > Date.now() + 60000) return baiduTtsToken;
  const url =
    'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials' +
    '&client_id=' + encodeURIComponent(s.baiduTtsApiKey) +
    '&client_secret=' + encodeURIComponent(s.baiduTtsSecretKey);
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error('获取百度 TTS 凭证失败: ' + JSON.stringify(data).slice(0, 150));
  }
  await chrome.storage.local.set({
    baiduTtsToken: data.access_token,
    baiduTtsTokenExp: Date.now() + (data.expires_in || 2592000) * 1000
  });
  return data.access_token;
}

async function baiduTts(text, s) {
  if (!s.baiduTtsApiKey || !s.baiduTtsSecretKey) {
    throw new Error('未配置百度语音合成 API Key/Secret Key，请到设置页填写');
  }
  const token = await baiduTtsToken(s);
  const res = await fetch('https://tsn.baidu.com/text2audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      tex: text,
      tok: token,
      cuid: 'translate-learner-ext',
      ctp: '1',
      lan: 'zh', // 支持中英文混读
      aue: '4', // mp3-48k
      spd: '4'
    }).toString()
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`百度语音合成错误 ${j.err_no || ''}: ${j.err_msg || JSON.stringify(j).slice(0, 150)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytesToBase64(bytes);
}

// ---------- LLM 深度讲解 ----------
function buildExplainPrompt(text, context) {
  const isWord = text.trim().split(/\s+/).length === 1;
  const sys = isWord
    ? '你是一位耐心的英语老师，帮助中国学生通过阅读网页学英语。请用简体中文讲解，严格按以下格式输出（不要输出其他内容）：\n【词义辨析】结合上下文解释该词在句中的含义，并与其他易混词义对比\n【词根词缀】拆解词根、词缀，帮助记忆（若无明显词根则说明）\n【常见搭配】列出3-5个高频短语搭配，附中文释义\n【例句】3个由易到难的英文例句，每句附中文翻译'
    : '你是一位耐心的英语老师，帮助中国学生通过阅读网页学英语。请用简体中文讲解，严格按以下格式输出（不要输出其他内容）：\n【句子结构】分析主干和修饰成分（主谓宾、从句、插入语等）\n【翻译要点】说明翻译时的关键处理（语序调整、词性转换、固定表达等）\n【地道表达】指出其中值得学习的词组或句型\n【仿写例句】2个运用相同句型的仿写例句，附中文翻译';
  const user = context ? `原文：${text}\n\n上下文：${context}` : `原文：${text}`;
  return sys + '\n\n' + user;
}

async function deepExplain(text, context, settings) {
  const prompt = buildExplainPrompt(text, context);
  if (settings.llmEngine === 'doubao') {
    return doubaoExplain(prompt);
  }
  return openaiExplain(prompt, settings);
}

// OpenAI 兼容接口
async function openaiExplain(prompt, settings) {
  if (!settings.llmApiKey) {
    throw new Error('未配置 LLM API Key，请点击面板右上角设置填写，或切换为豆包网页版（免 Key）');
  }
  const res = await fetch(
    settings.llmBaseURL.replace(/\/+$/, '') + '/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.llmApiKey
      },
      body: JSON.stringify({
        model: settings.llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5
      })
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('LLM 请求失败 ' + res.status + '：' + body.slice(0, 200));
  }
  const data = await res.json();
  const content =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  if (!content) throw new Error('LLM 返回内容为空');
  return content;
}

// 豆包网页版（复用浏览器登录 Cookie，免 Key，逆向 /samantha/chat/completion SSE 协议）
function doubaoRandNum(len) {
  let s = '7';
  for (let i = 1; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

async function doubaoExplain(prompt) {
  const deviceId = doubaoRandNum(19);
  const params = new URLSearchParams({
    aid: '497858',
    real_aid: '497858',
    device_id: deviceId,
    web_id: doubaoRandNum(19),
    tea_uuid: deviceId,
    device_platform: 'web',
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    pkg_type: 'release_version',
    version_code: '20800',
    pc_version: '2.44.0',
    samantha_web: '1',
    'use-olympus-account': '1',
    web_tab_id: crypto.randomUUID()
    // msToken 故意不带：伪造值会触发风控 710022002，不带反而安全
  });
  const body = {
    messages: [
      {
        content: JSON.stringify({ text: prompt }),
        content_type: 2001,
        attachments: [],
        references: []
      }
    ],
    completion_option: {
      is_regen: false,
      with_suggest: false,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      is_ai_playground: false,
      memory_type: 2,
      message_from: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false
    },
    evaluate_option: { web_ab_params: '' },
    local_conversation_id: crypto.randomUUID(),
    local_message_id: crypto.randomUUID()
  };
  const res = await fetch(
    'https://www.doubao.com/samantha/chat/completion?' + params.toString(),
    {
      method: 'POST',
      credentials: 'include', // 携带用户在 doubao.com 的登录 Cookie
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Agw-Js-Conv': 'str'
      },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    throw new Error(
      '豆包请求失败 ' + res.status + (res.status === 401 ? '：请先在浏览器登录 www.doubao.com' : '')
    );
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => ({}));
    throw new Error(
      '豆包返回错误: ' +
        (j.msg || j.message || JSON.stringify(j).slice(0, 150)) +
        '（请打开 www.doubao.com 确认已登录且能正常对话）'
    );
  }

  // 解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const et = Number(data.event_type);
      if (et === 2005) {
        throw new Error('豆包返回错误: ' + JSON.stringify(data.event_data).slice(0, 200));
      }
      if (et === 2003) {
        finished = true;
        break;
      }
      if (et !== 2001) continue;
      let ed = data.event_data;
      if (typeof ed === 'string') {
        try {
          ed = JSON.parse(ed);
        } catch {
          continue;
        }
      }
      let msg = ed && ed.message;
      if (typeof msg === 'string') {
        try {
          msg = JSON.parse(msg);
        } catch {
          continue;
        }
      }
      if (!msg) continue;
      const msgType = Number(msg.content_type);
      if ([2008, 10040, 2002].includes(msgType)) continue; // 跳过思考/建议块
      let content = msg.content;
      if (typeof content === 'string') {
        try {
          content = JSON.parse(content);
        } catch {
          continue;
        }
      }
      const chunk = content && typeof content.text === 'string' ? content.text : '';
      if (!chunk) continue;
      // 兼容增量/全量两种推送方式
      if (out && chunk.startsWith(out) && chunk.length > out.length) out = chunk;
      else out += chunk;
    }
  }
  if (!out) {
    throw new Error('豆包未返回文本（可能未登录或风控拦截），请打开 www.doubao.com 确认登录状态');
  }
  return out;
}

// ---------- Offscreen 播放（绕过网站页面 CSP 对 media-src 的限制） ----------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: '播放 TTS 朗读音频'
  });
}
// createDocument 返回后页面脚本可能尚未注册监听，重试发送
async function sendOffscreen(payload) {
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage(payload);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
      // 重试前确保文档仍存在
      try {
        await ensureOffscreen();
      } catch {
        /* 已存在 */
      }
    }
  }
  throw new Error('offscreen 播放页未响应');
}
async function playOffscreen(base64List) {
  await ensureOffscreen();
  await sendOffscreen({ type: 'OFFSCREEN_PLAY', audioBase64List: base64List });
}
async function stopOffscreen() {
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  }
}
// 把 offscreen 的播放结束/出错事件广播给所有标签页的内容脚本
async function broadcastToTabs(payload) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null) chrome.tabs.sendMessage(t.id, payload).catch(() => {});
  }
}

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'SELECTION') {
        const text = (msg.text || '').trim();
        if (!text) return sendResponse({ ok: false, error: '空文本' });
        const settings = await getSettings();
        if (!settings.enabled) return sendResponse({ ok: false, error: '已关闭' });
        let result;
        try {
          result = cacheGet(text);
          if (!result) {
            result = await quickTranslate(text, settings);
            cacheSet(text, result);
          }
        } catch (e) {
          // 快译失败也要通知面板，避免"没反应"的假死状态
          const errPayload = {
            original: text,
            error: e.message || String(e),
            ts: Date.now()
          };
          await chrome.storage.local.set({ latest: errPayload });
          chrome.runtime.sendMessage({ type: 'TRANSLATED', data: errPayload }).catch(() => {});
          return sendResponse({ ok: false, error: errPayload.error });
        }
        const payload = { original: text, ...result, context: msg.context || '', ts: Date.now() };
        await chrome.storage.local.set({ latest: payload });
        // 广播给面板（面板若已打开会实时更新）
        chrome.runtime.sendMessage({ type: 'TRANSLATED', data: payload }).catch(() => {});
        return sendResponse({ ok: true });
      }
      if (msg.type === 'DEEP') {
        const settings = await getSettings();
        const content = await deepExplain(msg.original, msg.context, settings);
        return sendResponse({ ok: true, content });
      }
      if (msg.type === 'PARA') {
        // 双语对照模式：整段翻译（复用快译引擎与缓存）
        const text = (msg.text || '').trim();
        if (!text) return sendResponse({ ok: false });
        const settings = await getSettings();
        if (!settings.enabled) return sendResponse({ ok: false });
        let result = cacheGet(text);
        if (!result) {
          result = await quickTranslate(text, settings);
          cacheSet(text, result);
        }
        return sendResponse({ ok: true, translation: result.translation });
      }
      if (msg.type === 'TTS') {
        // 供扩展自身页面（面板）使用：返回 base64，页面自行播放（扩展页无 CSP 限制）
        const settings = await getSettings();
        const engine = settings.ttsEngine;
        if (engine === 'system') return sendResponse({ ok: false, error: 'system' });
        const result = await synthWithFallback(msg.text || '', settings);
        return sendResponse(result);
      }
      if (msg.type === 'TTS_PLAY') {
        // 供内容脚本使用：SW 合成后转交 offscreen 播放（绕过网站 CSP）
        const settings = await getSettings();
        const engine = settings.ttsEngine;
        if (engine === 'system') return sendResponse({ ok: false, error: 'system' });
        const result = await synthWithFallback(msg.text || '', settings);
        if (!result.ok) return sendResponse(result);
        try {
          await playOffscreen(result.audioBase64List);
          return sendResponse({ ok: true, engine: result.engine });
        } catch (e) {
          return sendResponse({ ok: false, error: e.message || String(e) });
        }
      }
      if (msg.type === 'TTS_STOP') {
        await stopOffscreen();
        return sendResponse({ ok: true });
      }
      if (msg.type === 'OFFSCREEN_ENDED') {
        broadcastToTabs({ type: 'TTS_ENDED' });
        return sendResponse({ ok: true });
      }
      if (msg.type === 'OFFSCREEN_ERROR') {
        broadcastToTabs({ type: 'TTS_ERROR', error: msg.error || '' });
        return sendResponse({ ok: true });
      }
      sendResponse({ ok: false, error: '未知消息类型' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // 保持通道以支持异步响应
});

// ---------- 生命周期 ----------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, vocab: [] });
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 快捷键：开关划词翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translation') return;
  const settings = await getSettings();
  const enabled = !settings.enabled;
  await chrome.storage.local.set({ settings: { ...settings, enabled } });
  const badgeText = enabled ? 'ON' : 'OFF';
  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#0F6E56' : '#A32D2D' });
});
