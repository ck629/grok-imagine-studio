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
 */

const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Readable } = require('stream');

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
const PROXY_ROUTES = {
  'GET  /api/image-generation-models': true,
  'GET  /api/video-generation-models': true,
  'POST /api/images/generations': true,
  'POST /api/images/edits': true,
  'POST /api/videos/generations': true,
  'POST /api/videos/edits': true,
  'POST /api/videos/extensions': true,
};

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
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.end(await upstream.text());
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method}  ${url.pathname}`;

  if (route === 'GET  /api/health') {
    return sendJson(res, 200, {
      hasServerKey: Boolean(ENV_KEY),
      base: XAI_BASE,
      version: '1.0.0',
    });
  }

  // /api/videos/{request_id} 与 /api/images/{request_id} 轮询 (GET, 动态段)
  const isVideoPoll = req.method === 'GET' && /^\/api\/videos\/[\w-]+$/.test(url.pathname);
  const isImagePoll = req.method === 'GET' && /^\/api\/images\/[\w-]+$/.test(url.pathname);
  if (!PROXY_ROUTES[route] && !isVideoPoll && !isImagePoll) {
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
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
    upstream = await fetch(upstreamUrl, init);
  } catch (err) {
    return sendJson(res, 502, {
      error: { code: 'upstream_unreachable', message: `无法连接 xAI API: ${err.message}` },
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
  console.log('');
});
