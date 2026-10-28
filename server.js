#!/usr/bin/env node
'use strict';

/**
 * Grok Imagine Studio - 零依赖 Node 服务器
 *
 * 职责:
 *  1. 托管 public/ 下的前端静态文件
 *  2. 作为 xAI Imagine API 的白名单代理, 解决浏览器 CORS 限制,
 *     API Key 可由浏览器请求头携带 (x-xai-key), 也可由服务端环境变量 XAI_API_KEY 提供
 *
 * 环境变量:
 *  PORT          监听端口, 默认 8187
 *  XAI_API_KEY   服务端 API Key (可选, 前端未携带 Key 时启用)
 *  XAI_BASE_URL  上游 Base URL, 默认 https://api.x.ai
 *  HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY  出站代理(详见 .env.example)
 */

const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { proxyFetch, describeProxy } = require('./proxy');

/* ---------- .env 自动加载（零依赖实现） ----------
 * 启动时读取项目目录下的 .env 文件, 已存在的环境变量优先, 不覆盖
 * 格式: KEY=VALUE, 支持引号包裹与 # 注释行
 */
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;
  try {
    const raw = fsSync.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([\w.]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch (err) {
    console.warn(`  警告: .env 文件读取失败: ${err.message}`);
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 8187);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const XAI_BASE = (process.env.XAI_BASE_URL || 'https://api.x.ai').replace(/\/+$/, '');
const ENV_KEY = process.env.XAI_API_KEY || '';
const MAX_BODY_BYTES = 400 * 1024 * 1024; // 2K x 10 张 b64_json 响应可能很大
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// 仅代理这些路径, 防止变成任意 URL 的开放代理
// 统一归一化为 "METHOD /path"(单空格), 避免空白差异导致路由失效
const PROXY_ROUTES = new Set([
  'GET /api/image-generation-models',
  'GET /api/video-generation-models',
  'POST /api/images/generations',
  'POST /api/images/edits',
  'POST /api/videos/generations',
  'POST /api/videos/edits',
  'POST /api/videos/extensions',
].map((s) => s.replace(/\s+/g, ' ').trim()));

// /api/videos/{request_id} 与 /api/images/{request_id} 轮询 (GET, 动态段)
const POLL_ROUTE = /^GET \/api\/(videos|images)\/[\w-]+$/;

/* ---------- 参数持久化 (跨设备记忆上一次的使用参数) ----------
 * 存于项目内 data/prefs.json, 同一服务地址下的所有设备共享
 * 仅接受白名单键 + 标量值, 防止写入任意内容
 */
const DATA_DIR = path.join(__dirname, 'data');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const PREF_KEYS = new Set([
  'mode',
  'imageModel', 'videoModel',
  'imageAspect', 'videoAspect',
  'imageRes', 'videoRes',
  'quality', 'n', 'format',
  'duration', 'durationExt',
  'deferred', 'generateAudio', 'userId',
]);

function sanitizePrefs(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (!PREF_KEYS.has(k)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof v)) continue;
    if (typeof v === 'string' && v.length > 200) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

async function readPrefs() {
  try {
    const raw = await fs.readFile(PREFS_FILE, 'utf8');
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function writePrefs(prefs) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PREFS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(prefs, null, 2), 'utf8');
  await fs.rename(tmp, PREFS_FILE);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function pipeUpstream(res, upstream) {
  const headers = {
    'Content-Type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  res.writeHead(upstream.status, headers);
  if (upstream.stream) {
    upstream.stream.pipe(res);
  } else {
    res.end();
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`.replace(/\s+/g, ' ');

  if (route === 'GET /api/health') {
    return sendJson(res, 200, {
      hasServerKey: Boolean(ENV_KEY),
      base: XAI_BASE,
      proxy: describeProxy(),
      version: '1.0.0',
    });
  }

  // 参数记忆: 读取 / 保存上一次使用的参数 (跨设备共享)
  if (route === 'GET /api/prefs') {
    return sendJson(res, 200, await readPrefs());
  }
  if (route === 'POST /api/prefs') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: { code: 'bad_request', message: err.message } });
    }
    const prefs = sanitizePrefs(body);
    try {
      await writePrefs(prefs);
      return sendJson(res, 200, { ok: true, prefs });
    } catch (err) {
      return sendJson(res, 500, {
        error: { code: 'prefs_write_failed', message: `参数保存失败: ${err.message}` },
      });
    }
  }

  // 连通性自检: 经当前代理配置探测上游, 无需 Key
  if (route === 'GET /api/diag') {
    const target = `${XAI_BASE}/v1/models`;
    const started = Date.now();
    const proxy = describeProxy();
    try {
      const r = await proxyFetch(target, { timeoutMs: 15000 });
      const chunks = [];
      for await (const c of r.stream) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      return sendJson(res, 200, {
        ok: true,
        target,
        proxy: proxy || '未配置 (直连)',
        upstreamStatus: r.status,
        ms: Date.now() - started,
        sample: body.slice(0, 300),
      });
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        target,
        proxy: proxy || '未配置 (直连)',
        error: err.message,
        ms: Date.now() - started,
      });
    }
  }

  // 动态轮询段: /api/videos/{id} · /api/images/{id}
  if (!PROXY_ROUTES.has(route) && !POLL_ROUTE.test(route)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: `未知接口: ${route}` } });
  }

  const apiKey = String(req.headers['x-xai-key'] || ENV_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 401, {
      error: {
        code: 'missing_api_key',
        message: '未提供 API Key: 请在页面右上角"设置"中填写, 或在服务端配置 XAI_API_KEY 环境变量。',
      },
    });
  }

  // '/api/xxx' -> '{XAI_BASE}/v1/xxx'
  const upstreamUrl = `${XAI_BASE}/v1${url.pathname.slice(4)}${url.search || ''}`;

  const init = {
    method: req.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (req.method === 'POST') {
    try {
      init.body = JSON.stringify(await readJsonBody(req));
    } catch (err) {
      return sendJson(res, err.status || 400, {
        error: { code: 'bad_request', message: err.message },
      });
    }
  }

  let upstream;
  try {
    upstream = await proxyFetch(upstreamUrl, { ...init, timeoutMs: UPSTREAM_TIMEOUT_MS });
  } catch (err) {
    const proxyInfo = describeProxy();
    console.error(
      `[upstream] ${req.method} ${url.pathname} 失败: ${err.message}` +
      (proxyInfo ? ` (经代理 ${proxyInfo})` : ' (直连)')
    );
    return sendJson(res, 502, {
      error: {
        code: 'upstream_unreachable',
        message: `无法连接 xAI API: ${err.message}` +
          (proxyInfo ? `（经代理 ${proxyInfo}，可在浏览器访问 /api/diag 查看详情）` : '（直连，可在浏览器访问 /api/diag 查看详情）'),
      },
    });
  }

  await pipeUpstream(res, upstream);
}

async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(res, url);
    } else {
      res.writeHead(405);
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { code: 'internal_error', message: err.message } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Grok Imagine Studio 已启动');
  console.log(`  地址:     http://${HOST}:${PORT}`);
  console.log(`  上游:     ${XAI_BASE}`);
  console.log(`  服务端Key: ${ENV_KEY ? '已配置 (XAI_API_KEY)' : '未配置 (请在页面设置中填写)'}`);
  const proxyInfo = describeProxy();
  if (proxyInfo) console.log(`  出站代理: ${proxyInfo}`);
  console.log('');
});
