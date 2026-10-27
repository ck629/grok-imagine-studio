'use strict';

/* ================================================================
 * 零依赖出站代理支持
 * 读取标准环境变量(通常写在 .env 中):
 *   HTTPS_PROXY / https_proxy   首选(访问 https 上游时使用)
 *   HTTP_PROXY  / http_proxy    次选
 *   ALL_PROXY   / all_proxy     兜底
 *   NO_PROXY    / no_proxy      逗号分隔的免代理主机(如 localhost,127.0.0.1)
 *
 * 代理地址格式:
 *   http://[user:pass@]host:port          HTTP 代理(https 目标走 CONNECT 隧道)
 *   socks5://[user:pass@]host:port        SOCKS5, 本地解析 DNS
 *   socks5h://[user:pass@]host:port       SOCKS5, 由代理解析 DNS
 *
 * 代理只作用于服务端到上游 api.x.ai 的请求, 不影响浏览器访问本服务。
 * ================================================================ */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

const CONNECT_TIMEOUT_MS = 30000;

function pickProxyEnv() {
  const env = process.env;
  const url =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy || '';
  return url.trim();
}

function shouldBypassProxy(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!raw) return false;
  const host = hostname.toLowerCase();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function getProxyFor(targetUrl) {
  let raw = pickProxyEnv();
  if (!raw) return null;
  // 容错: 省略协议时默认按 http 代理处理 (如 127.0.0.1:7890)
  if (!/^[a-z0-9+.-]+:\/\//i.test(raw)) raw = `http://${raw}`;
  if (shouldBypassProxy(targetUrl.hostname)) return null;
  let proxyUrl;
  try {
    proxyUrl = new URL(raw);
  } catch {
    throw new Error(`代理地址格式无法解析: ${raw} (示例: http://127.0.0.1:7890 或 socks5h://127.0.0.1:1080)`);
  }
  const proto = proxyUrl.protocol.replace(':', '');
  if (!['http', 'https', 'socks5', 'socks5h'].includes(proto)) {
    throw new Error(`不支持的代理协议: ${proxyUrl.protocol} (支持 http/https/socks5/socks5h)`);
  }
  return {
    proto,
    hostname: proxyUrl.hostname,
    port: Number(proxyUrl.port) || (proto.startsWith('socks') ? 1080 : 80),
    auth: proxyUrl.username
      ? { user: decodeURIComponent(proxyUrl.username), pass: decodeURIComponent(proxyUrl.password || '') }
      : null,
  };
}

/* ---------- 工具: 带超时的 Promise 包装 ---------- */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------- HTTP CONNECT 隧道 ---------- */
function connectViaHttpProxy(proxy, target) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? 443 : 80);
    let socket = net.connect(proxy.port, proxy.hostname);
    socket.once('error', reject);
    // 代理主动断开(如对端不可达)时及时失败, 而不是挂到超时
    socket.once('close', () => reject(new Error('代理连接被关闭')));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('连接代理服务器超时'));
    });

    const begin = () => {
      const authHeader = proxy.auth
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r\n` +
        `Host: ${target.hostname}:${port}\r\n${authHeader}\r\n`
      );

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.removeListener('data', onData);
        const head = buffer.slice(0, end).toString();
        if (!/^HTTP\/1\.[01] 200/.test(head)) {
          socket.destroy();
          return reject(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
        }
        socket.setTimeout(0);
        resolve(socket);
      };
      socket.on('data', onData);
    };

    if (proxy.proto === 'https') {
      // 代理本身走 TLS (https:// 代理)
      socket.once('connect', () => {
        socket = tls.connect({ socket, servername: proxy.hostname }, begin);
        socket.once('error', reject);
      });
    } else {
      socket.once('connect', begin);
    }
  });
}

/* ---------- SOCKS5 握手 ---------- */
function connectViaSocks5(proxy, target) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? 443 : 80);
    const socket = net.connect(proxy.port, proxy.hostname);
    socket.once('error', reject);
    // 代理主动断开(如认证失败/对端不可达)时及时失败, 而不是挂到超时
    socket.once('close', () => reject(new Error('SOCKS5 代理连接被关闭')));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('连接 SOCKS5 代理超时'));
    });

    // 阶段: 方法协商 -> 用户名密码(可选) -> 连接请求 -> 应答
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const fail = (msg) => {
      socket.destroy();
      reject(new Error(msg));
    };

    socket.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting' && buffer.length >= 2) {
        if (buffer[0] !== 0x05) return fail('SOCKS5 协议错误(版本)');
        const method = buffer[1];
        buffer = buffer.slice(2);
        if (method === 0x02) {
          if (!proxy.auth) return fail('代理要求用户名密码认证, 请在代理地址中提供 user:pass');
          const u = Buffer.from(proxy.auth.user);
          const p = Buffer.from(proxy.auth.pass || '');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
        } else if (method === 0x00) {
          sendRequest();
        } else {
          return fail('SOCKS5 代理不接受可用认证方式');
        }
      }

      if (stage === 'auth' && buffer.length >= 2) {
        const ok = buffer[1] === 0x00;
        buffer = buffer.slice(2);
        if (!ok) return fail('SOCKS5 用户名或密码错误');
        sendRequest();
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return;
        const rep = buffer[1];
        if (rep !== 0x00) return fail(`SOCKS5 连接目标失败(错误码 ${rep})`);
        const atyp = buffer[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buffer[4] : 0;
        if (!addrLen) return fail('SOCKS5 协议错误(地址类型)');
        if (buffer.length < 4 + addrLen + 2) return; // 等完整应答
        buffer = Buffer.alloc(0);
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        resolve(socket);
      }
    });

    function sendRequest() {
      stage = 'connect';
      const hostBuf = Buffer.from(target.hostname);
      // socks5h: 域名交给代理解析; socks5: 本地解析后传 IP
      if (proxy.proto === 'socks5h') {
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        socket.write(req);
      } else {
        dns.lookup(target.hostname, (err, address) => {
          if (err) return fail(`DNS 解析失败: ${err.message}`);
          const ipParts = address.split('.').map(Number);
          const req = Buffer.from([
            0x05, 0x01, 0x00, 0x01,
            ...ipParts,
            (port >> 8) & 0xff, port & 0xff,
          ]);
          socket.write(req);
        });
      }
    }

    socket.once('connect', () => {
      const methods = proxy.auth ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
  });
}

/* ---------- 对外主入口 ---------- */

/**
 * 代理感知的请求函数, 返回 { status, headers, stream }
 * headers 为 Node 原生响应头对象; stream 为可读流
 */
async function proxyFetch(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 600000 } = {}) {
  const target = new URL(urlString);
  const isHttps = target.protocol === 'https:';
  const proxy = getProxyFor(target);

  let socket = null;
  if (proxy) {
    socket = await withTimeout(
      proxy.proto.startsWith('socks')
        ? connectViaSocks5(proxy, target)
        : connectViaHttpProxy(proxy, target),
      CONNECT_TIMEOUT_MS + 2000,
      '代理握手超时'
    );
    if (isHttps) {
      socket = tls.connect({ socket, servername: target.hostname });
      await withTimeout(
        new Promise((resolve, reject) => {
          socket.once('secureConnect', resolve);
          socket.once('error', reject);
        }),
        CONNECT_TIMEOUT_MS,
        'TLS 握手超时(经代理)'
      );
    }
  }

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;

    // 代理模式: 用一次性 Agent 把已建好的隧道 socket 交给请求
    // 注意: 不能用 agent:false + options.createConnection —— Node 在这种情况下会忽略
    // createConnection 而直连目标, 导致隧道被绕过(表现为"CONNECT 成功但请求失败")
    let agentOpt;
    if (socket) {
      const Base = isHttps ? https.Agent : http.Agent;
      const tunnelAgent = new Base({ keepAlive: false, maxSockets: 1 });
      tunnelAgent.createConnection = (opts, cb) => {
        cb(null, socket);
        return undefined;
      };
      agentOpt = tunnelAgent;
    }

    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: { ...headers, Host: target.host },
    };
    if (agentOpt) options.agent = agentOpt;

    const req = lib.request(options, (res) => {
      clearTimeout(overallTimer);
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });

    // 整体超时覆盖连接阶段(TCP/TLS 挂起时也能及时失败)
    const overallTimer = setTimeout(() => {
      req.destroy(new Error('请求超时(含连接阶段)'));
    }, timeoutMs);
    req.once('error', (err) => {
      clearTimeout(overallTimer);
      reject(err);
    });

    if (body) req.write(body);
    req.end();
  });
}

function describeProxy() {
  const raw = pickProxyEnv();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const auth = u.username ? `${decodeURIComponent(u.username)}:***@` : '';
    return `${u.protocol}//${auth}${u.hostname}:${u.port}`;
  } catch {
    return '(格式无法解析)';
  }
}

module.exports = { proxyFetch, describeProxy };
