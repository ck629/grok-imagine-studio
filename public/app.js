'use strict';

/* ================================================================
 * Grok Imagine Studio - 前端逻辑
 * 六种模式：文生图 / 图片编辑 / 文生视频 / 图生视频 / 视频编辑 / 视频延展
 * 覆盖 xAI Imagine API 全部请求参数
 * 模型下拉全部来自官方 API（/v1/image-generation-models、/v1/video-generation-models）
 * ================================================================ */

const $ = (id) => document.getElementById(id);

/* ---------- 常量 ---------- */

const MODES = {
  t2i: {
    label: '文生图', kind: 'image', api: '/api/images/generations', btn: '生成图像',
    imageUpload: null, keyframes: false, videoSource: false, refs: false, audios: false,
    aspect: true, n: true, duration: null, format: true, quality: true, promptRequired: true,
    placeholder: '描述你想生成的画面…\n例如：一只机械风格的水母漂浮在霓虹城市上空，电影感光效，超高细节',
  },
  edit: {
    label: '图片编辑', kind: 'image', api: '/api/images/edits', btn: '开始编辑',
    imageUpload: { max: 5, label: '参考图（最多 5 张）', rule: '多图编辑时可在提示词里用 <IMAGE_0>、<IMAGE_1> 指代各图' },
    keyframes: false, videoSource: false, refs: false, audios: false,
    aspect: true, n: true, duration: null, format: true, quality: true, promptRequired: true,
    placeholder: '描述要做的修改…\n例如：把背景换成黄昏的海滩，保留人物姿态和光影方向',
  },
  t2v: {
    label: '文生视频', kind: 'video', api: '/api/videos/generations', btn: '生成视频',
    imageUpload: null, keyframes: false, videoSource: false, refs: true, audios: true, lastFrame: true,
    aspect: true, n: false, duration: { min: 1, max: 15, def: 8 }, format: false, promptRequired: true,
    placeholder: '描述镜头：场景、运动、氛围…\n例如：航拍镜头缓缓推近雪山之巅，云海翻涌，日落金光洒在雪坡上',
  },
  i2v: {
    label: '图生视频', kind: 'video', api: '/api/videos/generations', btn: '生成视频',
    imageUpload: { max: 1, label: '首帧图片', rule: '作为视频首帧，PNG / JPG / WebP' },
    keyframes: true, videoSource: false, refs: true, audios: true, lastFrame: true,
    aspect: true, n: false, duration: { min: 1, max: 15, def: 8 }, format: false, promptRequired: false,
    placeholder: '描述这张画面的动态（可留空，仅按图片生成）…\n例如：镜头缓慢推近，头发随风飘动，背景虚化光斑流动',
  },
  vedit: {
    label: '视频编辑', kind: 'video', api: '/api/videos/edits', btn: '编辑视频',
    imageUpload: null, keyframes: false, videoSource: { duration: false }, refs: false, audios: false,
    aspect: false, n: false, duration: null, format: false, promptRequired: true,
    placeholder: '描述要做的修改…\n例如：给画面添加大雪，保持人物动作和镜头不变',
  },
  vext: {
    label: '视频延展', kind: 'video', api: '/api/videos/extensions', btn: '延展视频',
    imageUpload: null, keyframes: false, videoSource: { duration: true }, refs: false, audios: false,
    aspect: false, n: false, duration: { min: 2, max: 10, def: 6 }, format: false, promptRequired: true,
    placeholder: '描述接下来发生什么…\n例如：镜头缓缓拉远，露出城市天际线全景',
  },
};

// 官方 API 允许的宽高比 / 分辨率枚举
const IMAGE_ASPECT = ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2'];
const VIDEO_ASPECT = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'];
const IMAGE_RES = ['1k', '1.5k', '2k'];
const VIDEO_RES = ['480p', '720p', '1080p'];

const LIMITS = {
  imageMb: 12,
  videoMb: 100,
  audioMb: 20,
  audioSec: 15.5,
  keyframes: 4,
  refs: 14,
  audios: 3,
};

const LS_KEY = 'gis.apiKey';
const LS_USER = 'gis.userId';
const POLL_INTERVAL_MS = 3000;

/* ---------- 状态 ---------- */

const state = {
  mode: 't2i',
  apiKey: localStorage.getItem(LS_KEY) || '',
  serverHasKey: false,
  models: { image: [], video: [] },
  selectedModel: { image: '', video: '' },
  // 每个模式的输入数据
  modeData: {
    edit: { images: [] },
    i2v: { images: [], keyframes: [], refs: [], audios: [], voiceIds: '', lastFrame: null },
    t2v: { refs: [], audios: [], voiceIds: '', lastFrame: null },
    vedit: { videoUrl: '', videoData: null, videoName: '' },
    vext: { videoUrl: '', videoData: null, videoName: '' },
  },
  generating: false,
};

function md() {
  return state.modeData[state.mode] || {};
}

/* ---------- 工具 ---------- */

function toast(message, type = 'info', ms = 5200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const usdFromTicks = (ticks) =>
  typeof ticks === 'number' && !Number.isNaN(ticks) ? ticks / 1e10 : null;

function formatCost(usage) {
  const usd = usage ? usdFromTicks(usage.cost_in_usd_ticks) : null;
  return usd === null ? '' : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function currentModeCfg() {
  return MODES[state.mode];
}

function modality() {
  return currentModeCfg().kind; // 'image' | 'video'
}

function hasKey() {
  return Boolean(state.apiKey || state.serverHasKey);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function checkAudioDuration(dataUrl) {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(audio.duration || null);
    audio.onerror = () => resolve(null);
    audio.src = dataUrl;
  });
}

/* ---------- API 封装 ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.apiKey) headers['x-xai-key'] = state.apiKey;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }

  if (!res.ok) {
    throw new Error(
      data?.error?.message || data?.error?.code || data?.message || `HTTP ${res.status}`
    );
  }
  return data;
}

/* ---------- 模型列表（来自官方 API） ---------- */

// 质量档位（quality 存在但未写入 REST 文档，实际生效且影响计费）
// 档位枚举不写死：从模型返回的 pricing 矩阵里提取
function qualitiesForModel(model) {
  const set = new Set();
  if (Array.isArray(model?.pricing)) {
    for (const p of model.pricing) if (p.quality) set.add(p.quality);
  }
  return [...set];
}

function renderQualityOptions() {
  const sel = $('qualitySelect');
  const model = state.models.image.find((m) => m.id === $('modelSelect').value);
  const qualities = model ? qualitiesForModel(model) : [];

  if (!qualities.length) {
    sel.innerHTML = '<option value="">该模型无质量档位</option>';
    sel.disabled = true;
    return;
  }

  const order = { low: 0, medium: 1, high: 2 };
  qualities.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));

  const prev = sel.value;
  sel.innerHTML = '';
  for (const q of qualities) {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = q;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.value = qualities.includes(prev) ? prev : qualities.includes('medium') ? 'medium' : qualities[0];
}

function currentPriceEntry(model) {
  if (!model) return null;
  if (Array.isArray(model.pricing) && model.pricing.length) {
    const q = $('qualitySelect').value;
    const r = $('resSelect').value;
    return (
      model.pricing.find((p) => (!q || p.quality === q) && (!r || p.resolution === r)) ||
      model.pricing.find((p) => (!q || p.quality === q)) ||
      model.pricing[0]
    );
  }
  return null;
}

async function loadModels({ silent = false } = {}) {
  const [imgRes, vidRes] = await Promise.allSettled([
    api('/api/image-generation-models'),
    api('/api/video-generation-models'),
  ]);

  // 官方返回结构为 { models: [...] }（部分端点/版本为 { data: [...] }），统一归一化
  const pick = (r) => {
    if (r.status !== 'fulfilled') return [];
    const v = r.value;
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.data)) return v.data;
    if (Array.isArray(v?.models)) return v.models;
    return [];
  };
  state.models.image = pick(imgRes);
  state.models.video = pick(vidRes);

  const imgOk = imgRes.status === 'fulfilled';
  const vidOk = vidRes.status === 'fulfilled';

  setConnStatus(
    imgOk || vidOk ? 'ok' : 'err',
    imgOk && vidOk ? '已连接' : imgOk ? '已连接（视频模型列表获取失败）' : '模型列表获取失败'
  );

  if (imgRes.status === 'rejected' && vidRes.status === 'rejected') {
    if (!silent) toast(`模型列表获取失败：${imgRes.reason?.message || vidRes.reason?.message}`, 'error');
  } else if (!silent && (imgRes.status === 'rejected' || vidRes.status === 'rejected')) {
    toast(`部分模型列表获取失败：${(imgRes.reason || vidRes.reason)?.message}`, 'error');
  }

  renderModelSelect();
}

function renderModelSelect() {
  const sel = $('modelSelect');
  const kind = modality();
  const models = state.models[kind] || [];
  sel.innerHTML = '';

  if (!hasKey()) {
    sel.innerHTML = '<option value="">请先在设置中填写 API Key</option>';
  } else if (!models.length) {
    sel.innerHTML = kind === 'video'
      ? '<option value="">当前 Key 无可用视频模型（该能力可能未开通）</option>'
      : '<option value="">未获取到模型（点击 ↻ 重试）</option>';
  } else {
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const alias = Array.isArray(m.aliases) && m.aliases.length ? `（${m.aliases.join(', ')}）` : '';
      opt.textContent = `${m.id}${alias}`;
      sel.appendChild(opt);
    }
    const saved = state.selectedModel[kind];
    if (saved && models.some((m) => m.id === saved)) sel.value = saved;
    else state.selectedModel[kind] = sel.value;
  }

  renderQualityOptions();
  renderPriceHint();
}

function renderPriceHint() {
  const hintEl = $('priceHint');
  const kind = modality();
  const sel = $('modelSelect');
  if (kind !== 'image' || !sel.value) {
    hintEl.hidden = true;
    return;
  }
  const model = state.models.image.find((m) => m.id === sel.value);
  if (!model) {
    hintEl.hidden = true;
    return;
  }

  const entry = currentPriceEntry(model);
  let text = '';
  if (entry) {
    const usd = usdFromTicks(entry.price_per_image);
    const parts = [];
    if (entry.quality) parts.push(`quality=${entry.quality}`);
    if (entry.resolution) parts.push(entry.resolution);
    text = `$${usd.toFixed(3)} / 张${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  } else if (typeof model.image_price === 'number') {
    const usd = usdFromTicks(model.image_price);
    text = `$${usd.toFixed(3)} / 张`;
  }
  hintEl.textContent = text;
  hintEl.hidden = !text;
}

/* ---------- 模式切换 ---------- */

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  const cfg = currentModeCfg();

  $('prompt').placeholder = cfg.placeholder;
  $('generateBtnText').textContent = cfg.btn;

  const isImage = cfg.kind === 'image';

  // 上传区块可见性
  $('uploadBlock').hidden = !cfg.imageUpload;
  if (cfg.imageUpload) {
    $('uploadLabel').textContent = cfg.imageUpload.label;
    $('uploadRule').textContent = cfg.imageUpload.rule || '';
  }
  $('keyframesBlock').hidden = !cfg.keyframes;
  $('lastFrameBlock').hidden = !cfg.lastFrame;
  $('videoSrcBlock').hidden = !cfg.videoSource;
  $('refsBlock').hidden = !cfg.refs;
  $('audiosBlock').hidden = !cfg.audios;
  $('audioToggleRow').hidden = !(cfg.kind === 'video' && cfg.api.endsWith('/videos/generations'));

  // 几何参数（仅生成类端点支持）
  $('geomGrid').hidden = !cfg.aspect;
  if (cfg.aspect) {
    const aspectValues = isImage ? IMAGE_ASPECT : VIDEO_ASPECT;
    const prev = $('aspectSelect').value;
    fillSelect($('aspectSelect'), aspectValues, aspectValues.includes(prev) ? prev : (isImage ? 'auto' : '16:9'));
    const resValues = isImage ? IMAGE_RES : VIDEO_RES;
    const prevRes = $('resSelect').value;
    fillSelect($('resSelect'), resValues, resValues.includes(prevRes) ? prevRes : (isImage ? '1k' : '720p'));
  }

  $('nBlock').hidden = !cfg.n;
  $('formatBlock').hidden = !cfg.format;
  $('qualityBlock').hidden = !cfg.quality;

  // 时长
  const d = cfg.duration;
  $('durationBlock').hidden = !d;
  if (d) {
    const input = $('durationInput');
    input.min = d.min;
    input.max = d.max;
    input.value = d.def;
    $('durationVal').textContent = `${d.def} 秒`;
    $('durationLabel').textContent = mode === 'vext' ? '延展片段时长' : '时长';
  }

  // 高级参数
  $('deferredRow').hidden = !isImage;
  $('outputUrlsHint').textContent = isImage
    ? '每行一条签名 URL，数量须等于生成张数 n（PUT 上传生成图）'
    : '单条签名 URL（PUT 上传生成视频，Content-Type: video/mp4）';
  $('outputUrls').placeholder = isImage ? 'https://…\nhttps://…' : 'https://…';

  renderAllLists();
  updatePromptHint();
  renderModelSelect();
}

function fillSelect(sel, values, selectedValue) {
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  if (selectedValue && values.includes(selectedValue)) sel.value = selectedValue;
}

function updatePromptHint() {
  $('promptHint').textContent = state.mode === 'i2v' ? '图生视频提示词可留空' : '';
}

/* ---------- 列表渲染（通用） ---------- */

function renderThumbList(container, list, { removable = true } = {}) {
  container.innerHTML = '';
  list.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${item.dataUrl}" alt="" /><span class="idx">${i}</span>`;
    if (removable) {
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.title = '移除';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        list.splice(i, 1);
        renderAllLists();
      });
      div.appendChild(rm);
    }
    container.appendChild(div);
  });
}

function renderAllLists() {
  const cfg = currentModeCfg();
  const data = md();

  if (cfg.imageUpload) renderThumbList($('thumbs'), data.images);
  if (cfg.refs) renderThumbList($('refThumbs'), data.refs);

  // 末帧（last_frame）单图
  if (cfg.lastFrame) {
    const box = $('lfThumbs');
    box.innerHTML = '';
    if (data.lastFrame) {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `<img src="${data.lastFrame.dataUrl}" alt="" /><button class="rm" title="移除">✕</button>`;
      div.querySelector('.rm').addEventListener('click', () => {
        data.lastFrame = null;
        renderAllLists();
      });
      box.appendChild(div);
    }
  }

  // 关键帧：图片 + 时间戳
  if (cfg.keyframes) {
    const box = $('kfList');
    box.innerHTML = '';
    data.keyframes.forEach((kf, i) => {
      const row = document.createElement('div');
      row.className = 'kf-row';
      row.innerHTML = `
        <img src="${kf.dataUrl}" alt="" />
        <input type="number" class="kf-ts" min="0.1" step="0.1" value="${kf.ts}" title="timestamp_s：0 < t < 时长" />
        <button class="btn ghost small" type="button">✕</button>`;
      row.querySelector('.kf-ts').addEventListener('change', (e) => {
        kf.ts = Number(e.target.value) || kf.ts;
      });
      row.querySelector('button').addEventListener('click', () => {
        data.keyframes.splice(i, 1);
        renderAllLists();
      });
      box.appendChild(row);
    });
  }

  // 音频参考列表
  if (cfg.audios) {
    const box = $('audioList');
    box.innerHTML = '';
    data.audios.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'audio-row';
      row.innerHTML = `
        <span class="audio-name" title="${a.name}">${a.name}${a.duration ? ` · ${a.duration.toFixed(1)}s` : ''}</span>
        <button class="btn ghost small" type="button">✕</button>`;
      row.querySelector('button').addEventListener('click', () => {
        data.audios.splice(i, 1);
        renderAllLists();
      });
      box.appendChild(row);
    });
  }

  // 源视频预览
  if (cfg.videoSource) {
    const box = $('videoPreview');
    box.innerHTML = '';
    if (data.videoData) {
      const wrap = document.createElement('div');
      wrap.className = 'video-preview';
      wrap.innerHTML = `
        <video controls preload="metadata" src="${data.videoData}"></video>
        <div class="hint">${data.videoName} · <button class="link-btn" type="button">移除</button></div>`;
      wrap.querySelector('.link-btn').addEventListener('click', () => {
        data.videoData = null;
        data.videoName = '';
        renderAllLists();
      });
      box.appendChild(wrap);
    } else if (data.videoUrl) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = `将使用 URL：${data.videoUrl}`;
      box.appendChild(hint);
    }
  }
}

/* ---------- 文件添加 ---------- */

async function addImageFiles(fileList, listKey, max) {
  const data = md();
  const list = data[listKey];
  const files = Array.from(fileList).filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!files.length) {
    toast('仅支持 PNG / JPG / WebP 图片', 'error');
    return;
  }
  for (const file of files) {
    if (list.length >= max) {
      toast(`最多 ${max} 张`, 'error');
      break;
    }
    if (file.size > LIMITS.imageMb * 1024 * 1024) {
      toast(`「${file.name}」超过 ${LIMITS.imageMb}MB，已跳过`, 'error');
      continue;
    }
    list.push({ dataUrl: await readFileAsDataUrl(file), name: file.name });
  }
  renderAllLists();
}

async function addAudioFiles(fileList) {
  const data = md();
  const files = Array.from(fileList).filter((f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(f.name));
  if (!files.length) {
    toast('请选择音频文件', 'error');
    return;
  }
  for (const file of files) {
    if (data.audios.length + countVoiceIds() >= LIMITS.audios) {
      toast(`语音参考最多 ${LIMITS.audios} 条（含 voice_id）`, 'error');
      break;
    }
    if (file.size > LIMITS.audioMb * 1024 * 1024) {
      toast(`「${file.name}」超过 ${LIMITS.audioMb}MB，已跳过`, 'error');
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    const duration = await checkAudioDuration(dataUrl);
    if (duration && duration > LIMITS.audioSec) {
      toast(`「${file.name}」时长 ${duration.toFixed(1)}s 超过 15 秒，已跳过`, 'error');
      continue;
    }
    data.audios.push({ dataUrl, name: file.name, duration });
  }
  renderAllLists();
}

function countVoiceIds() {
  const data = md();
  return String(data.voiceIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

async function addVideoFile(file) {
  if (!/^video\/mp4$/.test(file.type) && !/\.mp4$/i.test(file.name)) {
    toast('源视频必须是 .mp4 格式', 'error');
    return;
  }
  if (file.size > LIMITS.videoMb * 1024 * 1024) {
    toast(`视频超过 ${LIMITS.videoMb}MB，建议改用公开 URL`, 'error');
    return;
  }
  const data = md();
  data.videoData = await readFileAsDataUrl(file);
  data.videoName = file.name;
  renderAllLists();
}

/* ---------- 请求体组装 ---------- */

function advancedExtras(body, isImage) {
  // user
  const user = $('userIdInput').value.trim();
  if (user) body.user = user;

  // output 上传地址
  const raw = $('outputUrls').value.trim();
  if (raw) {
    if (isImage) {
      const urls = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (urls.length) body.output = { upload_urls: urls };
    } else {
      body.output = { upload_url: raw.split(/\s+/)[0] };
    }
  }

  // storage_options
  const filename = $('storageFilename').value.trim();
  if (filename) {
    const so = { filename };
    const expires = Number($('storageExpires').value);
    if (expires && expires > 0) so.expires_after = Math.min(2592000, Math.round(expires));
    if ($('storagePublic').checked) so.public_url = true;
    body.storage_options = so;
  }
}

function buildImageBody(model, prompt) {
  const cfg = currentModeCfg();
  const data = md();
  const n = Math.min(10, Math.max(1, Number($('nInput').value) || 1));

  const body = {
    model,
    prompt,
    n,
    aspect_ratio: $('aspectSelect').value,
    response_format: $('formatSelect').value,
  };
  const res = $('resSelect').value;
  if (res) body.resolution = res;

  // quality: 官方 REST 文档未列出，但实际生效并影响计费(如 image-2.0 的 low 档更便宜)
  // 仅在该模型价目表存在质量档位时发送，避免无档位模型收到多余字段
  const qualitySel = $('qualitySelect');
  if (!qualitySel.disabled && qualitySel.value) body.quality = qualitySel.value;

  if (state.mode === 'edit') {
    if (data.images.length === 1) body.image = { url: data.images[0].dataUrl };
    else body.images = data.images.map((u) => ({ url: u.dataUrl }));
  }

  // deferred 仅支持 url 格式
  if ($('deferredToggle').checked && body.response_format === 'url') {
    body.deferred = true;
  }

  advancedExtras(body, true);
  return body;
}

function buildVideoGenBody(model, prompt) {
  const data = md();
  const body = {
    model,
    duration: Number($('durationInput').value) || currentModeCfg().duration.def,
    aspect_ratio: $('aspectSelect').value,
    resolution: $('resSelect').value,
  };
  if (prompt) body.prompt = prompt;

  if (state.mode === 'i2v' && data.images.length) {
    body.image = { url: data.images[0].dataUrl };
  }
  if (state.mode === 'i2v' && data.keyframes.length) {
    body.keyframes = data.keyframes.map((k) => ({
      image: { url: k.dataUrl },
      timestamp_s: k.ts,
    }));
  }
  // 末帧锚定: image + last_frame 会在两帧之间插值
  if (data.lastFrame) body.last_frame = { url: data.lastFrame.dataUrl };

  // 音轨开关(默认 true)
  body.generate_audio = $('generateAudioToggle').checked;
  if (data.refs && data.refs.length) {
    body.reference_images = data.refs.map((r) => ({ url: r.dataUrl }));
  }

  // 语音参考：文件 + voice_id 合计最多 3 条
  const voiceIds = String(data.voiceIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const audioRefs = [];
  for (const a of data.audios || []) audioRefs.push({ url: a.dataUrl });
  for (const id of voiceIds) audioRefs.push({ voice_id: id });
  if (audioRefs.length) body.reference_audios = audioRefs.slice(0, LIMITS.audios);

  advancedExtras(body, false);
  return body;
}

function buildVideoEditBody(model, prompt) {
  const data = md();
  if (!data.videoData && !data.videoUrl) {
    throw new Error('请上传源视频或填写 .mp4 链接');
  }
  const body = { model, prompt };
  body.video = data.videoData
    ? { url: data.videoData }
    : { url: data.videoUrl };

  if (state.mode === 'vext') {
    body.duration = Number($('durationInput').value) || currentModeCfg().duration.def;
  }

  advancedExtras(body, false);
  return body;
}

/* ---------- 生成入口 ---------- */

async function onGenerate() {
  if (state.generating) return;
  if (!hasKey()) {
    openSettings();
    toast('请先配置 API Key', 'error');
    return;
  }

  const cfg = currentModeCfg();
  const prompt = $('prompt').value.trim();

  // 视频生成: 只要带了 image / keyframes / last_frame / 参考图 / 语音, prompt 即可省略
  let promptRequired = cfg.promptRequired;
  if (cfg.api.endsWith('/videos/generations')) {
    const d = md();
    const hasAnyInput =
      (d.images && d.images.length) ||
      (d.keyframes && d.keyframes.length) ||
      (d.refs && d.refs.length) ||
      (d.audios && d.audios.length) ||
      countVoiceIds() > 0 ||
      d.lastFrame;
    if (hasAnyInput) promptRequired = false;
  }

  if (!prompt && promptRequired) {
    toast('请填写提示词', 'error');
    $('prompt').focus();
    return;
  }

  const model = $('modelSelect').value;
  if (!model) {
    toast('模型列表为空，请先点击 ↻ 从官方 API 加载模型', 'error');
    return;
  }

  if (cfg.imageUpload) {
    const needImage = state.mode === 'edit' || state.mode === 'i2v';
    if (needImage && !md().images.length) {
      toast(cfg.imageUpload.label + '：至少需要 1 张', 'error');
      return;
    }
  }

  try {
    if (cfg.kind === 'image') await generateImage(model, prompt);
    else if (state.mode === 'vedit' || state.mode === 'vext') await submitVideoJob(cfg.api, buildVideoEditBody(model, prompt));
    else await submitVideoJob(cfg.api, buildVideoGenBody(model, prompt));
  } catch (err) {
    toast(`请求失败：${err.message}`, 'error', 8000);
    setGenerating(false);
  }
}

function setGenerating(flag) {
  state.generating = flag;
  const btn = $('generateBtn');
  btn.disabled = flag;
  $('generateBtnText').textContent = flag ? `${currentModeCfg().btn}中…` : currentModeCfg().btn;
}

/* ----- 图像（同步 / deferred 异步） ----- */

async function generateImage(model, prompt) {
  setGenerating(true);
  const body = buildImageBody(model, prompt);
  const data = await api(currentModeCfg().api, { method: 'POST', body });

  if (data?.request_id) {
    // deferred 异步模式：轮询 GET /api/images/{request_id}
    const card = createProgressCard({ model, requestId: data.request_id, type: '图像' });
    toast('已提交异步图像任务（deferred）');
    setGenerating(false);
    await pollDeferredImage(data.request_id, card, model, body.n);
    return;
  }

  const items = data?.data || [];
  if (!items.length) throw new Error('接口未返回任何图像');

  const cost = formatCost(data.usage);
  for (const item of items) {
    const src = item.b64_json
      ? `data:${item.mime_type || 'image/jpeg'};base64,${item.b64_json}`
      : item.url;
    if (src) addImageCard({ src, model, cost, mime: item.mime_type || 'image/jpeg' });
  }
  toast(`完成：${items.length} 张图像${cost ? ` · ${cost}` : ''}`, 'success');
  setGenerating(false);
}

async function pollDeferredImage(requestId, card, model, n) {
  try {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const res = await fetch(`/api/images/${requestId}`, {
        headers: state.apiKey ? { 'x-xai-key': state.apiKey } : {},
      });

      if (res.status === 202) {
        updateProgress(card, null, '排队/生成中…');
        continue;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || '图像生成失败');

      const items = data.data || [];
      const cost = formatCost(data.usage);
      for (const item of items) {
        const src = item.b64_json
          ? `data:${item.mime_type || 'image/jpeg'};base64,${item.b64_json}`
          : item.url;
        if (src) addImageCard({ src, model, cost, mime: item.mime_type || 'image/jpeg' });
      }
      removeCard(card);
      toast(`异步图像任务完成：${items.length} 张${cost ? ` · ${cost}` : ''}`, 'success');
      return;
    }
  } catch (err) {
    failCard(card, err.message);
    toast(`异步图像任务失败：${err.message}`, 'error', 8000);
  }
}

/* ----- 视频（全部异步） ----- */

async function submitVideoJob(endpoint, body) {
  const model = body.model;
  const started = await api(endpoint, { method: 'POST', body });
  const requestId = started?.request_id;
  if (!requestId) throw new Error('接口未返回 request_id');

  const card = createProgressCard({ model, requestId, type: '视频' });
  toast('视频任务已提交，生成中…（通常需要几分钟）');
  setGenerating(false); // 释放按钮，允许并行任务

  await pollVideo(requestId, card, model);
}

async function pollVideo(requestId, card, model) {
  try {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const data = await api(`/api/videos/${requestId}`);

      if (data.status === 'done') {
        if (!data.video?.respect_moderation && !data.video?.url) {
          throw new Error('生成内容未通过审核（respect_moderation=false）');
        }
        const url = data.video?.url;
        if (!url) throw new Error('完成但未返回视频 URL');
        finishVideoCard(card, {
          url,
          model,
          cost: formatCost(data.usage),
          duration: data.video.duration,
        });
        toast('视频生成完成', 'success');
        return;
      }
      if (data.status === 'failed' || data.status === 'expired') {
        throw new Error(data.error?.message || `视频生成${data.status}`);
      }
      updateProgress(card, typeof data.progress === 'number' ? data.progress : null);
    }
  } catch (err) {
    failCard(card, err.message);
    toast(`视频任务失败：${err.message}`, 'error', 8000);
  }
}

/* ---------- 结果渲染 ---------- */

const EMPTY_HTML = `
  <div class="empty-state" id="emptyState">
    <div class="empty-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
    </div>
    <p>还没有内容</p>
    <p class="hint">写一条提示词，点击左侧生成按钮开始 · 结果可作为下一轮编辑/视频的输入</p>
  </div>`;

function hideEmptyState() {
  $('emptyState')?.remove();
}

function createCard() {
  hideEmptyState();
  const card = document.createElement('div');
  card.className = 'card';
  $('resultsGrid').prepend(card);
  return card;
}

function removeCard(card) {
  card.remove();
  if (!$('resultsGrid').children.length) {
    $('resultsGrid').innerHTML = EMPTY_HTML;
  }
}

function addImageCard({ src, model, cost, mime }) {
  const card = createCard();

  const media = document.createElement('div');
  media.className = 'card-media';
  media.innerHTML = `<img src="${src}" alt="生成结果" />`;
  card.appendChild(media);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <div class="card-meta">
      <span class="model-name" title="${model}">${model}</span>
      <span class="cost">${cost}</span>
    </div>
    <div class="card-actions">
      <button class="btn ghost" data-act="download">下载</button>
      <button class="btn ghost src-btn" data-act="to-edit">用作编辑源图</button>
      <button class="btn ghost src-btn" data-act="to-i2v">设为视频首帧</button>
    </div>`;
  card.appendChild(body);

  body.querySelector('[data-act="download"]').addEventListener('click', () => {
    if (src.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = src;
      a.download = `imagine-${Date.now()}.${mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'}`;
      a.click();
    } else {
      window.open(src, '_blank');
    }
  });
  body.querySelector('[data-act="to-edit"]').addEventListener('click', () => {
    state.modeData.edit.images = [{ dataUrl: src, name: 'result' }];
    setMode('edit');
    toast('已设为编辑源图，请在提示词中描述修改', 'success');
  });
  body.querySelector('[data-act="to-i2v"]').addEventListener('click', () => {
    state.modeData.i2v.images = [{ dataUrl: src, name: 'first-frame' }];
    setMode('i2v');
    toast('已设为视频首帧', 'success');
  });
}

function createProgressCard({ model, requestId, type }) {
  const card = createCard();
  card.innerHTML = `
    <div class="progress-card">
      <div class="spinner"></div>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <div class="progress-label">${type}生成中… ${model} · <span class="pct">已等待 0 秒</span></div>
    </div>`;
  card.dataset.requestId = requestId;
  card.dataset.startedAt = String(Date.now());
  return card;
}

function updateProgress(card, pct, pendingText) {
  if (!card.isConnected) return;
  const fill = card.querySelector('.progress-fill');
  const label = card.querySelector('.pct');
  if (pct !== null && pct !== undefined) {
    if (fill) fill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    if (label) label.textContent = `${pct}%`;
  } else if (label) {
    const waited = Math.round((Date.now() - Number(card.dataset.startedAt)) / 1000);
    label.textContent = pendingText || `已等待 ${waited} 秒`;
  }
}

function finishVideoCard(card, { url, model, cost, duration }) {
  if (!card.isConnected) return;
  card.innerHTML = '';
  const media = document.createElement('div');
  media.className = 'card-media';
  media.innerHTML = `<video controls preload="metadata" src="${url}"></video>`;
  card.appendChild(media);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <div class="card-meta">
      <span class="model-name" title="${model}">${model}${duration ? ` · ${duration}s` : ''}</span>
      <span class="cost">${cost}</span>
    </div>
    <div class="card-actions">
      <a class="btn ghost" href="${url}" target="_blank" rel="noopener">下载 / 打开</a>
      <button class="btn ghost src-btn" data-act="to-vedit">编辑此视频</button>
      <button class="btn ghost src-btn" data-act="to-vext">延展此视频</button>
    </div>`;
  card.appendChild(body);

  body.querySelector('[data-act="to-vedit"]').addEventListener('click', () => {
    state.modeData.vedit = { videoUrl: url, videoData: null, videoName: '' };
    setMode('vedit');
    toast('已填入视频编辑源', 'success');
  });
  body.querySelector('[data-act="to-vext"]').addEventListener('click', () => {
    state.modeData.vext = { videoUrl: url, videoData: null, videoName: '' };
    setMode('vext');
    toast('已填入视频延展源', 'success');
  });
}

function failCard(card, message) {
  if (!card.isConnected) return;
  card.innerHTML = `
    <div class="progress-card" style="color: var(--danger);">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div class="progress-label" style="color: var(--danger);">任务失败</div>
      <div class="hint" style="max-width: 90%;">${message}</div>
    </div>`;
}

/* ---------- 设置 ---------- */

function setConnStatus(kind, text) {
  const el = $('connStatus');
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
  $('connText').textContent = text;
}

function openSettings() {
  $('keyInput').value = state.apiKey || '';
  $('serverKeyHint').textContent = state.serverHasKey
    ? '当前服务端已配置 XAI_API_KEY 环境变量，此处留空即可直接使用服务端 Key。'
    : '服务端未配置 XAI_API_KEY 环境变量，请在此填写你自己的 Key。';
  const modal = $('settingsModal');
  modal.hidden = false;
  // 双保险: 不依赖 CSS 对 [hidden] 的处理, 显式控制显示
  modal.style.display = 'grid';
  $('keyInput').focus();
}

function closeSettings() {
  const modal = $('settingsModal');
  modal.hidden = true;
  modal.style.display = 'none';
}

async function saveKey() {
  const key = $('keyInput').value.trim();
  state.apiKey = key;
  if (key) localStorage.setItem(LS_KEY, key);
  else localStorage.removeItem(LS_KEY);
  closeSettings();
  toast(key ? 'Key 已保存，正在从官方 API 加载模型列表…' : '已清除本地 Key，正在加载模型列表…');
  await loadModels();
}

async function testKey() {
  const key = $('keyInput').value.trim();
  const prevKey = state.apiKey;
  state.apiKey = key;
  try {
    await loadModels({ silent: true });
    const ok = state.models.image.length || state.models.video.length;
    toast(
      ok
        ? `连接成功：图像模型 ${state.models.image.length} 个 · 视频模型 ${state.models.video.length} 个`
        : '连接成功，但未获取到模型',
      ok ? 'success' : 'error'
    );
  } catch (err) {
    toast(`连接失败：${err.message}`, 'error');
  } finally {
    state.apiKey = prevKey;
  }
}

/* ---------- 事件绑定 ---------- */

function bindDropzone(zoneEl, onFiles) {
  zoneEl.addEventListener('click', () => {
    const input = zoneEl.querySelector('input[type="file"]');
    if (input) input.click();
  });
  zoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    zoneEl.classList.add('dragover');
  });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    onFiles(e.dataTransfer.files);
  });
  const input = zoneEl.querySelector('input[type="file"]');
  if (input) {
    input.addEventListener('change', (e) => {
      onFiles(e.target.files);
      e.target.value = '';
    });
  }
}

function bindEvents() {
  $('modeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-tab');
    if (btn) setMode(btn.dataset.mode);
  });

  $('prompt').addEventListener('input', (e) => {
    $('promptCount').textContent = e.target.value.length;
  });

  // 主参考图上传（编辑 / 首帧）
  bindDropzone($('dropzone'), (files) => {
    addImageFiles(files, 'images', currentModeCfg().imageUpload.max);
  });
  $('dropzone').querySelector('input[type="file"]');
  document.addEventListener('paste', (e) => {
    if ($('uploadBlock').hidden || !$('settingsModal').hidden) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) addImageFiles(files, 'images', currentModeCfg().imageUpload.max);
  });

  // 关键帧
  $('addKeyframe').addEventListener('click', () => $('kfInput').click());
  $('kfInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const data = md();
    if (!file) return;
    if (data.keyframes.length >= LIMITS.keyframes) {
      toast(`关键帧最多 ${LIMITS.keyframes} 个`, 'error');
      return;
    }
    if (file.size > LIMITS.imageMb * 1024 * 1024) {
      toast(`「${file.name}」超过 ${LIMITS.imageMb}MB`, 'error');
      return;
    }
    const duration = Number($('durationInput').value) || 8;
    data.keyframes.push({
      dataUrl: await readFileAsDataUrl(file),
      ts: Math.max(0.1, Math.round(duration / 2 * 10) / 10),
    });
    renderAllLists();
  });

  // 末帧锚定
  bindDropzone($('lfDropzone'), async (files) => {
    const file = files[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast('末帧仅支持 PNG / JPG / WebP', 'error');
      return;
    }
    if (file.size > LIMITS.imageMb * 1024 * 1024) {
      toast(`「${file.name}」超过 ${LIMITS.imageMb}MB`, 'error');
      return;
    }
    md().lastFrame = { dataUrl: await readFileAsDataUrl(file), name: file.name };
    renderAllLists();
  });

  // 源视频（URL / 文件）
  $('videoUrlInput').addEventListener('change', (e) => {
    const url = e.target.value.trim();
    const data = md();
    data.videoUrl = url;
    if (url && !/\.mp4(\?|$)/i.test(url)) {
      toast('注意：官方要求 URL 必须带 .mp4 扩展名', 'error');
    }
    renderAllLists();
  });
  bindDropzone($('videoDropzone'), (files) => {
    if (files[0]) addVideoFile(files[0]);
  });

  // 参考图 R2V
  bindDropzone($('refDropzone'), (files) => {
    addImageFiles(files, 'refs', LIMITS.refs);
  });

  // 语音参考
  bindDropzone($('audioDropzone'), (files) => {
    addAudioFiles(files);
  });
  $('voiceIdInput').addEventListener('change', (e) => {
    md().voiceIds = e.target.value;
    const total = (md().audios?.length || 0) + countVoiceIds();
    if (total > LIMITS.audios) toast(`语音参考合计最多 ${LIMITS.audios} 条`, 'error');
  });

  // 参数联动
  $('durationInput').addEventListener('input', (e) => {
    $('durationVal').textContent = `${e.target.value} 秒`;
  });
  $('modelSelect').addEventListener('change', (e) => {
    state.selectedModel[modality()] = e.target.value;
    renderQualityOptions();
    renderPriceHint();
  });
  // 分辨率/质量变化时刷新价格提示
  $('resSelect').addEventListener('change', renderPriceHint);
  $('qualitySelect').addEventListener('change', renderPriceHint);
  $('refreshModels').addEventListener('click', () => {
    if (!hasKey()) {
      openSettings();
      toast('请先配置 API Key', 'error');
      return;
    }
    loadModels().then(() => {
      const kind = modality();
      toast(`已刷新：${kind === 'image' ? '图像' : '视频'}模型 ${state.models[kind].length} 个`, 'success');
    });
  });

  // deferred 依赖 url 格式
  $('formatSelect').addEventListener('change', () => {
    if ($('formatSelect').value !== 'url' && $('deferredToggle').checked) {
      $('deferredToggle').checked = false;
      toast('deferred 仅支持 url 返回格式，已自动关闭', 'info');
    }
  });
  $('deferredToggle').addEventListener('change', (e) => {
    if (e.target.checked && $('formatSelect').value !== 'url') {
      $('formatSelect').value = 'url';
      toast('已将返回格式切换为 url（deferred 仅支持 url）', 'info');
    }
  });

  $('userIdInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v) localStorage.setItem(LS_USER, v);
    else localStorage.removeItem(LS_USER);
  });

  $('generateBtn').addEventListener('click', onGenerate);

  $('clearResults').addEventListener('click', () => {
    $('resultsGrid').innerHTML = EMPTY_HTML;
  });

  // 设置弹窗
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });
  $('saveKeyBtn').addEventListener('click', saveKey);
  $('testKeyBtn').addEventListener('click', testKey);
  $('keyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveKey();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings();
  });
}

/* ---------- 启动 ---------- */

async function init() {
  bindEvents();
  $('userIdInput').value = localStorage.getItem(LS_USER) || '';
  setMode('t2i');

  try {
    const health = await api('/api/health');
    state.serverHasKey = Boolean(health?.hasServerKey);
    if (state.serverHasKey) $('serverKeyNote').hidden = false;
  } catch {
    /* ignore */
  }

  if (hasKey()) {
    await loadModels();
  } else {
    setConnStatus('err', '未配置 Key');
    renderModelSelect();
  }
}

init();
