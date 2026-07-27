#!/usr/bin/env node
// 构建 server.cjs — 从原版 server.js 提取所有API路由并追加到现有server.cjs
// 现有 server.cjs 末尾已有分析引擎导入，继续追加即可

const fs = require('fs');
const path = require('path');

const ORIGINAL_SERVER = '/home/node/.openclaw/tools/ads-web-backend/server.js';
const TARGET = '/home/node/.openclaw/github-ads-platform/src/server.cjs';
const NEW_FILE = TARGET + '.new';

// 读取原始文件
const original = fs.readFileSync(ORIGINAL_SERVER, 'utf-8');
const originalLines = original.split('\n');

// 读取现有 server.cjs（保留前半部分）
const existing = fs.readFileSync(TARGET, 'utf-8').trimEnd();

// ============ 提取 handleAPI 函数（从259行到server.listen前）============
// handleAPI 从 async function handleAPI(req, res, parts) { 开始
// 到 handleStatic 之前结束

function extractHandleAPI() {
  let startIdx = -1;
  let endIdx = -1;
  
  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];
    if (line.includes('async function handleAPI(req, res, parts)')) {
      startIdx = i;
    }
    if (startIdx > 0 && line.includes('const server = http.createServer')) {
      endIdx = i;
      break;
    }
  }
  
  if (startIdx < 0 || endIdx < 0) {
    console.error('无法找到 handleAPI 边界:', startIdx, endIdx);
    process.exit(1);
  }
  
  // 直接提取从 handleAPI 到 http.createServer 之间的所有代码
  const handleAPICode = originalLines.slice(startIdx, endIdx).join('\n');
  return handleAPICode;
}

// ============ 提取 server 启动部分 ============
function extractServerMain() {
  let startIdx = -1;
  
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].includes('const server = http.createServer')) {
      startIdx = i;
      break;
    }
  }
  
  if (startIdx < 0) {
    console.error('无法找到 http.createServer');
    process.exit(1);
  }
  
  const serverCode = originalLines.slice(startIdx).join('\n');
  return serverCode;
}

// ============ 构建最终 server.cjs ============
const handleAPICode = extractHandleAPI();
const serverMainCode = extractServerMain();

// 系统配置模块（替换原版中从 process.env/JSON 读取配置的方式）
const configModule = `
// ============================================================
// 系统配置（从SQLite读取）
// ============================================================
const db = require('./db.cjs');

// 配置缓存（带TTL刷新）
const configCache = {};

function getConfig(key, defaultValue = null) {
  if (configCache[key] && Date.now() - configCache[key].ts < 10000) {
    return configCache[key].value;
  }
  const val = db.getConfig(key);
  configCache[key] = { value: val !== undefined ? val : defaultValue, ts: Date.now() };
  return configCache[key].value;
}

function getAllConfig() {
  return db.getAllConfig();
}

function setConfig(key, value) {
  db.setConfig(key, value);
  configCache[key] = { value, ts: Date.now() };
}
`;

// 配置初始化代码（取代原版 process.env 读取方式）
const configInit = `
// ─── 从SQLite读取配置 ────────────────────────────────────────
let ADMIN_USER = getConfig('admin_user', 'admin');
let ADMIN_PASSWORD = getConfig('admin_password', 'admin888');
const AUTH_SECRET = getConfig('auth_secret', 'ads-platform-jwt-secret-' + Date.now());
const PORT = parseInt(getConfig('port', '18444'));
const MEMORY_LIMIT_MB = parseInt(getConfig('memory_limit_mb', '500'));
const LINGXING_APP_ID = getConfig('lingxing_app_id', '');
const LINGXING_APP_SECRET = getConfig('lingxing_app_secret', '');

// 卖家精灵配置
const SELLERSPRITE_URL = 'http://localhost:3000/mcp';
let SELLERSPRITE_SECRET = getConfig('sellersprite_secret', '');

// Webhook
let WECOM_WEBHOOK_URL = getConfig('wecom_webhook_url', '');
`;

// JWT 认证（直接使用，不改）
const jwtCode = `
// ============================================================
// JWT 认证
// ============================================================
const crypto = require('crypto');

function base64url(str) {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

function signHmac(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('base64url');
}

function generateToken(username) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { username, exp: Math.floor(Date.now() / 1000) + 86400 * 7 };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = signHmac(headerB64 + '.' + payloadB64, AUTH_SECRET);
  return headerB64 + '.' + payloadB64 + '.' + signature;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = signHmac(parts[0] + '.' + parts[1], AUTH_SECRET);
    if (parts[2] !== expectedSig) return null;
    const payload = JSON.parse(base64urlDecode(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { username: payload.username };
  } catch { return null; }
}

function authMiddleware(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const user = verifyToken(token);
  if (!user) {
    sendJSON(res, { error: '未授权，请重新登录' }, 401);
    return null;
  }
  return user;
}
`;

// 领星API调用
const lingxingAPICode = `
// ============================================================
// 领星 API（自动获取token）
// ============================================================
let lingxingTokenCache = { token: null, expiry: 0 };

async function getLingXingToken() {
  if (lingxingTokenCache.token && Date.now() < lingxingTokenCache.expiry - 60000) {
    return lingxingTokenCache.token;
  }
  
  const appId = getConfig('lingxing_app_id', '');
  const appSecret = getConfig('lingxing_app_secret', '');
  if (!appId || !appSecret) throw new Error('领星APP ID或Secret未配置');
  
  const res = await fetch('https://openapi.lingxing.com/api/auth-server/oauth/access/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret, grant_type: 'client_credentials' })
  });
  const data = await res.json();
  if (data.code === 0 && data.data?.access_token) {
    lingxingTokenCache = { token: data.data.access_token, expiry: Date.now() + data.data.expires_in * 1000 };
    return data.data.access_token;
  }
  throw new Error('领星认证失败: ' + (data.message || JSON.stringify(data)));
}

async function callLingXingApi(endpoint, method = 'GET', body = null) {
  const token = await getLingXingToken();
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const url = 'https://openapi.lingxing.com' + endpoint;
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timer);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('领星API超时(15s)');
    throw e;
  }
}
`;

// 卖家精灵MCP调用
const sellerspriteAPICode = `
// ============================================================
// 卖家精灵 MCP 调用
// ============================================================
async function callSellerspriteTool(toolName, args) {
  const secret = getConfig('sellersprite_secret', '');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(SELLERSPRITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json', 'secret-key': secret },
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error('卖家精灵返回非JSON: ' + text.slice(0, 200)); }
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('卖家精灵API超时(15s)');
    throw e;
  }
}
`;

// 企业微信Webhook推送
const wecomCode = `
// ============================================================
// 企微 Webhook 推送
// ============================================================
async function sendWecomMessage(message) {
  const webhookUrl = getConfig('wecom_webhook_url', '');
  if (!webhookUrl) return { success: false, error: '未配置Webhook URL' };
  
  const logId = db.createPushLog({ type: 'wecom_webhook', target: webhookUrl, message: message.slice(0, 200), status: 'pending' });
  
  try {
    const body = { msgtype: 'markdown', markdown: { content: message } };
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.errcode === 0) {
      db.updatePushLog(logId, { status: 'success' });
      return { success: true };
    } else {
      db.updatePushLog(logId, { status: 'failed', error: '企微返回: ' + (data.errmsg || JSON.stringify(data)) });
      return { success: false, error: data.errmsg };
    }
  } catch (e) {
    db.updatePushLog(logId, { status: 'failed', error: e.message });
    return { success: false, error: e.message };
  }
}
`;

// 分析引擎导入（已有，但重新确认）
const analysisEngineCode = `
// ─── ─── ─── ─── ─── ─── ───
//  分析引擎（导入）
// ─── ─── ─── ─── ─── ─── ───

let analyzeKeyword = null;
try {
  analyzeKeyword = require('./analysis-engine.cjs').analyze;
  console.log('[Ads-Web] 分析引擎 loaded ✅');
} catch (e) {
  console.error('[WARN] analysis-engine.cjs 未加载:', e.message);
  analyzeKeyword = function() { return { analysis: [], suggestions: ['分析引擎未加载'], summary: '引擎不可用', score: 0, scoreLabel: '不可用' }; };
}
`;

// ============ 构建完整文件 ============
const fullContent = [
  `#!/usr/bin/env node`,
  `// 广告关键词管理平台 - 服务端`,
  `// 自动构建于 ${new Date().toISOString()}`,
  ``,
  configModule,
  configInit,
  `const http = require('http');`,
  `const fs = require('fs');`,
  `const path = require('path');`,
  `const crypto = require('crypto');`,
  ``,
  jwtCode,
  lingxingAPICode,
  sellerspriteAPICode,
  wecomCode,
  analysisEngineCode,
  ``,
  `// ============================================================`,
  `// MIME类型 & HTTP工具函数`,
  `// ============================================================`,
  `const MIME = {`,
  `  '.html': 'text/html; charset=utf-8',`,
  `  '.js': 'application/javascript; charset=utf-8',`,
  `  '.css': 'text/css; charset=utf-8',`,
  `  '.json': 'application/json; charset=utf-8',`,
  `  '.png': 'image/png',`,
  `  '.ico': 'image/x-icon'`,
  `};`,
  ``,
  `function sendJSON(res, data, status = 200) {`,
  `  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });`,
  `  res.end(JSON.stringify(data));`,
  `}`,
  ``,
  `function sendError(res, msg, status = 400) {`,
  `  sendJSON(res, { error: msg }, status);`,
  `}`,
  ``,
  handleAPICode,
  ``,
  serverMainCode,
  ``,
  `// ─── SQLite 清理定时器 ────────────────────────────────────`,
  `setInterval(() => {`,
  `  try {`,
  `    // 清理7天前的推送日志`,
  `    db.cleanPushLogs(7);`,
  `  } catch(e) {}`,
  `}, 3600000);`,
  ``,
].join('\n');

// 写入文件
fs.writeFileSync(NEW_FILE, fullContent, 'utf-8');
// 替换原文件
fs.renameSync(NEW_FILE, TARGET);

console.log(`✅ server.cjs 已生成: ${fullContent.split('\n').length} lines`);
