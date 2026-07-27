#!/usr/bin/env node
// 广告关键词管理平台 - 服务端
// 自动构建于 2026-07-27T03:05:29.687Z

// ============================================================
// 系统配置（从SQLite读取，使用默认值兜底）
// ============================================================
const db = require('./db.cjs');

// 配置缓存（带TTL刷新）
const configCache = {};
let DB_READY = false;

function getConfig(key, defaultValue = null) {
  if (!DB_READY) return defaultValue;
  if (configCache[key] && Date.now() - configCache[key].ts < 10000) {
    return configCache[key].value;
  }
  try {
    const val = db.getConfig(key);
    configCache[key] = { value: val !== undefined ? val : defaultValue, ts: Date.now() };
    return configCache[key].value;
  } catch(e) {
    return defaultValue;
  }
}

function getAllConfig() {
  if (!DB_READY) return [];
  return db.getAllConfig();
}

function setConfig(key, value) {
  if (!DB_READY) return;
  db.setConfig(key, value);
  configCache[key] = { value, ts: Date.now() };
}

// 默认配置（DB初始化前使用）
let ADMIN_USER = 'admin';
let ADMIN_PASSWORD = 'admin888';
let AUTH_SECRET = 'ads-platform-jwt-secret-' + Date.now();
let PORT = 18444;
let MEMORY_LIMIT_MB = 500;
let LINGXING_APP_ID = '';
let LINGXING_APP_SECRET = '';
const SELLERSPRITE_URL = process.env.SELLERSPRITE_URL || 'https://mcp.sellersprite.com/mcp';
let SELLERSPRITE_SECRET = '99da44546fed4fb2926660dc28e25810';
let WECOM_WEBHOOK_URL = '';
let DINGTALK_WEBHOOK_URL = '';
let DINGTALK_SECRET = '';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const md5 = require('md5');
const qs = require('qs');

// 分析引擎（懒加载）
let analyzeKeyword = null;
try {
  analyzeKeyword = require('./analysis-engine.cjs').analyze;
  console.log('[Ads-Web] 分析引擎 loaded ✅');
} catch (e) {
  console.error('[WARN] analysis-engine.cjs 未加载:', e.message);
  analyzeKeyword = function() { return { analysis: [], suggestions: ['分析引擎未加载'], summary: '引擎不可用', score: 0, scoreLabel: '不可用' }; };
}

// ============================================================
// JWT 认证
// ============================================================
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
  
  // 参考生产版 ads-web-backend/server.js 的领星 token 获取方式
  const params = new URLSearchParams();
  params.append('appId', appId);
  params.append('appSecret', appSecret);
  const res = await fetch('https://openapi.lingxing.com/api/auth-server/oauth/access-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const data = await res.json();
  if (data.code === 0 || data.code === '0' || String(data.code) === '0') {
    lingxingTokenCache = { token: data.data.access_token, expiry: Date.now() + (data.data.expires_in || 7200) * 1000 };
    return data.data.access_token;
  }
  // 兼容新版领星（返回200表示成功）
  if (String(data.code) === '200' || String(data.code) === '0') {
    const token = data.data?.access_token || data.data?.token;
    if (token) {
      lingxingTokenCache = { token, expiry: Date.now() + (data.data.expires_in || 7200) * 1000 };
      return token;
    }
  }
  throw new Error('领星认证失败: ' + (data.msg || data.message || JSON.stringify(data)));
}

function isPlainObject(val) {
  return Object.prototype.toString.call(val) === '[object Object]' || Array.isArray(val);
}

function generateSign(params, appKey) {
  const sortedKeys = Object.keys(params).sort();
  const stringArr = sortedKeys.map(key => {
    const value = isPlainObject(params[key]) ? JSON.stringify(params[key]) : String(params[key]);
    return `${key}=${value}`;
  });
  const joined = stringArr.join('&');
  const md5Upper = md5(joined).toString().toUpperCase();
  const _key = CryptoJS.enc.Utf8.parse(appKey);
  const encrypted = CryptoJS.AES.encrypt(md5Upper.trim(), _key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  });
  return encrypted.toString();
}

// ========== 修改记录 ==========
const HISTORY_PATH = path.join(__dirname, 'modify_history.json');

function loadChangeMap() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        const map = {};
        for (const entry of data) {
          if (!map[entry.id]) map[entry.id] = entry;
        }
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(map, null, 2), 'utf8');
        return map;
      }
      return data;
    }
  } catch(e) { console.error('读取修改记录失败:', e.message); }
  return {};
}

async function callLingXingApi(path, method, bizParams = {}) {
  const token = await getLingXingToken();
  const appKey = getConfig('lingxing_app_id', '');
  const timestamp = Math.floor(Date.now() / 1000);
  const baseParams = { access_token: token, app_key: appKey, timestamp };
  const signAll = { ...baseParams, ...bizParams };
  const sign = generateSign(signAll, appKey);
  baseParams.sign = sign;

  const fullUrl = `https://openapi.lingxing.com${path}`;
  let url, options;

  if (method === 'GET') {
    const allQuery = { ...baseParams, ...bizParams };
    url = `${fullUrl}?${qs.stringify(allQuery)}`;
    options = { method: 'GET' };
  } else {
    url = `${fullUrl}?${qs.stringify(baseParams)}`;
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bizParams) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  options.signal = controller.signal;
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`领星API HTTP ${res.status}`);
    const json = await res.json();
    // 成功码兼容：auth(code=200)、常规API(code=0)、listing/publish(code=1)
    if (String(json.code) !== '200' && json.code !== 0 && String(json.code) !== '0' && json.code !== 1) {
      throw new Error(`领星API错误: ${json.msg || json.message || JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 卖家精灵 MCP 调用
// ============================================================
async function callSellerspriteTool(toolName, args) {
  const secret = SELLERSPRITE_SECRET || getConfig('sellersprite_secret', '');
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

// ============================================================
// 企微 Webhook 推送
// ============================================================
async function sendWecomMessage(message) {
  const webhookUrl = getConfig('wecom_webhook_url', '');
  if (!webhookUrl) return { success: false, error: '未配置Webhook URL' };
  
  const logId = db.createPushLog({ type: 'wecom_webhook', target: webhookUrl, title: message.slice(0, 200), status: 'pending' });
  
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

// ============================================================
// 钉钉 Webhook 推送
// ============================================================
async function sendDingtalkMessage(message) {
  const webhookUrl = getConfig('dingtalk_webhook_url', '');
  if (!webhookUrl) return { success: false, error: '未配置钉钉Webhook URL' };
  
  const logId = db.createPushLog({ type: 'dingtalk_webhook', target: webhookUrl, title: message.slice(0, 200), status: 'pending' });
  
  try {
    // 构建请求 URL（可能带签名）
    let url = webhookUrl;
    const secret = getConfig('dingtalk_secret', '');
    if (secret) {
      const timestamp = Date.now();
      const stringToSign = timestamp + '\n' + secret;
      const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest();
      const sign = encodeURIComponent(Buffer.from(hmac).toString('base64'));
      url += (url.includes('?') ? '&' : '?') + 'timestamp=' + timestamp + '&sign=' + sign;
    }
    
    const body = { msgtype: 'markdown', markdown: { title: '系统通知', text: message } };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.errcode === 0) {
      db.updatePushLog(logId, { status: 'success' });
      return { success: true };
    } else {
      db.updatePushLog(logId, { status: 'failed', error: '钉钉返回: ' + (data.errmsg || JSON.stringify(data)) });
      return { success: false, error: data.errmsg };
    }
  } catch (e) {
    db.updatePushLog(logId, { status: 'failed', error: e.message });
    return { success: false, error: e.message };
  }
}

function loadConfigFromDB() {
  ADMIN_USER = getConfig('admin_user', 'admin');
  ADMIN_PASSWORD = getConfig('admin_password', 'admin888');
  AUTH_SECRET = getConfig('auth_secret', 'ads-platform-jwt-secret-' + Date.now());
  PORT = parseInt(process.env.PORT || getConfig('port', '18444'));
  MEMORY_LIMIT_MB = parseInt(getConfig('memory_limit_mb', '500'));
  LINGXING_APP_ID = getConfig('lingxing_app_id', '');
  LINGXING_APP_SECRET = getConfig('lingxing_app_secret', '');
  SELLERSPRITE_SECRET = getConfig('sellersprite_secret', '');
  WECOM_WEBHOOK_URL = getConfig('wecom_webhook_url', '');
  DINGTALK_WEBHOOK_URL = getConfig('dingtalk_webhook_url', '');
  DINGTALK_SECRET = getConfig('dingtalk_secret', '');
}

// ============================================================
// HTTP工具函数
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 400) {
  sendJSON(res, { error: msg }, status);
}

// ============================================================
// API路由处理
// ============================================================
async function handleAPI(req, res, parts) {
  const method = req.method;
  const parsed = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(parsed.searchParams.entries());

  // POST helper
  function readBody() {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
      req.on('error', reject);
    });
  }

  try {
    // === 健康检查 ===
    if (parts[0] === 'health' && method === 'GET') {
      return sendJSON(res, { ok: true, time: Date.now(), version: '2.0.0' });
    }

    // === 设置管理（SQLite持久化）===
    if (parts[0] === 'settings' && method === 'GET') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const allConfig = getAllConfig();
      const configObj = {};
      allConfig.forEach(c => { configObj[c.key] = c.value; });
      // 仅隐藏系统内部密钥
      const SENSITIVE_KEYS = ['auth_secret'];
      SENSITIVE_KEYS.forEach(k => delete configObj[k]);
      if (configObj.admin_password) configObj.admin_password = '********';
      return sendJSON(res, { settings: configObj });
    }
    if (parts[0] === 'settings' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const body = await readBody();
      const ALLOWED_KEYS = [
        'port', 'lingxing_app_id', 'lingxing_app_secret', 'sellersprite_secret',
        'auth_secret', 'wecom_webhook_url', 'memory_limit_mb',
        'dingtalk_webhook_url', 'dingtalk_secret',
        // 大模型配置
        'ai_llm_provider', 'ai_llm_api_key', 'ai_llm_base_url', 'ai_llm_model'
      ];
      for (const [key, value] of Object.entries(body)) {
        if (ALLOWED_KEYS.includes(key)) {
          setConfig(key, value);
        }
      }
      if (body.port) PORT = parseInt(body.port);
      if (body.wecom_webhook_url) WECOM_WEBHOOK_URL = body.wecom_webhook_url;
      if (body.dingtalk_webhook_url) DINGTALK_WEBHOOK_URL = body.dingtalk_webhook_url;
      if (body.dingtalk_secret) DINGTALK_SECRET = body.dingtalk_secret;
      if (body.sellersprite_secret) SELLERSPRITE_SECRET = body.sellersprite_secret;
      return sendJSON(res, { success: true });
    }
    
    // === 用户管理（仅admin）===
    if (parts[0] === 'users' && method === 'GET') {
      const user = authMiddleware(req, res);
      if (!user) return;
      // 验证是admin
      const u = db.getUserByUsername(user.username);
      if (!u || u.role !== 'admin') return sendError(res, '无权限', 403);
      const users = db.getUsers();
      return sendJSON(res, { users });
    }
    if (parts[0] === 'users' && parts[1] === 'create' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const u = db.getUserByUsername(user.username);
      if (!u || u.role !== 'admin') return sendError(res, '无权限', 403);
      const body = await readBody();
      if (!body.username || !body.password) return sendError(res, '用户名和密码必填');
      const result = db.createUser({
        username: body.username,
        password: body.password,
        role: body.role || 'user',
        nick_name: body.nick_name || body.username
      });
      return sendJSON(res, result);
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'update' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const u = db.getUserByUsername(user.username);
      if (!u || u.role !== 'admin') return sendError(res, '无权限', 403);
      const body = await readBody();
      const id = parseInt(parts[1]);
      db.updateUser(id, {
        password: body.password || undefined,
        role: body.role || undefined,
        nick_name: body.nick_name || undefined,
        is_active: body.is_active !== undefined ? (body.is_active ? 1 : 0) : undefined
      });
      return sendJSON(res, { success: true });
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'delete' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const u = db.getUserByUsername(user.username);
      if (!u || u.role !== 'admin') return sendError(res, '无权限', 403);
      const id = parseInt(parts[1]);
      db.deleteUser(id);
      return sendJSON(res, { success: true });
    }

    // === 推送日志 ===
    if (parts[0] === 'push-logs' && method === 'GET') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const limit = parseInt(query.limit) || 50;
      const logs = db.getPushLogs(limit);
      return sendJSON(res, { logs });
    }

    // === 设置测试Webhook ===
    if (parts[0] === 'settings' && parts[1] === 'test-wecom' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const result = await sendWecomMessage('🧪 广告关键词管理平台测试消息\n\n> 配置验证通过 ✅\n\n时间: ' + new Date().toLocaleString('zh-CN'));
      return sendJSON(res, result);
    }

    // === 设置测试钉钉Webhook ===
    if (parts[0] === 'settings' && parts[1] === 'test-dingtalk' && method === 'POST') {
      const user = authMiddleware(req, res);
      if (!user) return;
      const result = await sendDingtalkMessage('🧪 广告关键词管理平台测试消息\n\n> 配置验证通过 ✅\n\n时间: ' + new Date().toLocaleString('zh-CN'));
      return sendJSON(res, result);
    }

    // === 登录认证 ===
    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
      const body = await readBody();
      // 从users表验证
      const user = db.getUserByUsername(body.username);
      if (user && user.password === body.password && user.is_active) {
        const token = generateToken(body.username);
        return sendJSON(res, { token, username: body.username, role: user.role, nick_name: user.nick_name });
      }
      // 兼容旧的 system_config 方式（降级）
      if (body.username === ADMIN_USER && body.password === ADMIN_PASSWORD) {
        const token = generateToken(body.username);
        return sendJSON(res, { token, username: body.username, role: 'admin' });
      }
      return sendJSON(res, { error: '用户名或密码错误' }, 401);
    }
    if (parts[0] === 'auth' && parts[1] === 'verify' && method === 'GET') {
      const user = verifyToken(req.headers['authorization']?.slice(7) || '');
      return sendJSON(res, { valid: !!user, username: user?.username || null });
    }

    // === 店铺列表 ===
    if (parts[0] === 'stores' && method === 'GET') {
      try {
        const result = await callLingXingApi('/erp/sc/data/seller/lists', 'GET');
        return sendJSON(res, { stores: result.data || [] });
      } catch(e) {
        console.error('[stores] 领星API错误:', e.message);
        return sendJSON(res, { error: '领星API: ' + e.message }, 500);
      }
    }

    // === 调试：sbTargeting 原始数据 ===
    if (parts[0] === 'debug' && parts[1] === 'sb' && method === 'GET') {
      const sid = Number(query.sid);
      const profile_id = Number(query.profile_id);
      const campaign_id = String(query.campaign_id || '');
      const ads_type = query.ads_type || 'ALL';
      const targeting_type = query.targeting_type || 'ALL';
      const offset = Number(query.offset || 0);
      const length = Number(query.length || 5000);
      try {
        const result = await callLingXingApi('/pb/openapi/newad/sbTargeting', 'POST', {
          sid, profile_id, ads_type, targeting_type, offset, length
        });
        const items = result.data || [];
        const filtered = campaign_id ? items.filter(t => String(t.campaign_id) === campaign_id) : items;
        return sendJSON(res, { total: items.length, filtered: filtered.length, ads_type, targeting_type, offset, length, items: filtered });
      } catch(e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // === 广告组合列表 ===
    if (parts[0] === 'portfolios' && method === 'GET') {
      if (!query.sid) return sendError(res, '缺少 sid 参数');
      const result = await callLingXingApi('/pb/openapi/newad/portfolios', 'POST', { sid: Number(query.sid), offset: 0, length: 1000 });
      let portfolios = result.data || [];
      // 过滤掉弃用/空组合（名字以废弃/空开头或大部分横线/标点）
      if (query.filter_inactive !== 'false') {
        portfolios = portfolios.filter(p => {
          const name = (p.name || '').trim();
          if (name.startsWith('弃用') || name.startsWith('空')) return false;
          // 排除仅由横线/空格/标点组成
          const clean = name.replace(/[-—–\s·.。，,]+/g, '');
          if (clean.length === 0) return false;
          return true;
        });
      }
      return sendJSON(res, { portfolios });
    }

    // === 广告组合活动数统计（支持 state 参数过滤）===
    if (parts[0] === 'portfolio-counts' && method === 'GET') {
      if (!query.sid) return sendError(res, '缺少 sid 参数');
      const sid = Number(query.sid);
      // 拉取全部活动（不过滤状态），统计每个组合下的活动数
      // 注意：领星 campaign 的 portfolio_id 与 portfolios API 的 ID 
      // 在多数店铺中吻合，但部分新创建/已删除组合的 campaign 可能不匹配
      const [spResult, sbResult, sdResult] = await Promise.all([
        callLingXingApi('/pb/openapi/newad/spCampaigns', 'POST', { sid, offset: 0, length: 10000 }).catch(() => ({ data: [] })),
        callLingXingApi('/pb/openapi/newad/hsaCampaigns', 'POST', { sid, offset: 0, length: 2000 }).catch(() => ({ data: [] })),
        callLingXingApi('/pb/openapi/newad/sdCampaigns', 'POST', { sid, offset: 0, length: 2000 }).catch(() => ({ data: [] }))
      ]);
      
      const allCampaigns = [
        ...(spResult.data || []),
        ...(sbResult.data || []),
        ...(sdResult.data || [])
      ];
      
      const counts = {};
      for (const c of allCampaigns) {
        if (c.portfolio_id != null) {
          counts[c.portfolio_id] = (counts[c.portfolio_id] || 0) + 1;
        }
      }
      return sendJSON(res, { counts });
    }

    // === 活动列表 ===
    if (parts[0] === 'campaigns' && method === 'GET') {
      if (!query.sid) return sendError(res, '缺少 sid 参数');
      const sid = Number(query.sid);
      const pid = query.portfolio_id ? Number(query.portfolio_id) : null;
      
      const stateFilter = query.state || ''; // 'enabled' | 'paused' | ''
      
      // 领星API支持 state=paused/archived，但 state=enabled 返回 0（VSITOO-US 无 enabled 数据）
      // 因此启用/暂定通过本地 serving_status 判断，暂停传 state='paused' 给领星
      const useLxStateFilter = stateFilter === 'paused';
      
      // 拉取 SP + SB(HSA) + SD
      const spParams = { sid, offset: 0, length: 10000 };
      const sbParams = { sid, offset: 0, length: 2000 };
      const sdParams = { sid, offset: 0, length: 2000 };
      if (useLxStateFilter) {
        spParams.state = stateFilter;
        sbParams.state = stateFilter;
        sdParams.state = stateFilter;
      }
      const [spResult, sbResult, sdResult] = await Promise.all([
        callLingXingApi('/pb/openapi/newad/spCampaigns', 'POST', spParams).catch(e => { console.error('spCampaigns err:', e.message); return { data: [] }; }),
        callLingXingApi('/pb/openapi/newad/hsaCampaigns', 'POST', sbParams).catch(e => { console.error('hsaCampaigns err:', e.message); return { data: [] }; }),
        callLingXingApi('/pb/openapi/newad/sdCampaigns', 'POST', sdParams).catch(e => { console.error('sdCampaigns err:', e.message); return { data: [] }; })
      ]);
      
      let allCampaigns = [
        ...(spResult.data || []).map(c => ({ ...c, campaign_type_label: 'SP' })),
        ...(sbResult.data || []).map(c => ({ ...c, campaign_type_label: 'SB' })),
        ...(sdResult.data || []).map(c => ({ ...c, campaign_type_label: 'SD' }))
      ];
      
      // 保存全量原始数据（用于 portfolio ID 匹配检查）
      const rawCampaigns = allCampaigns.slice();
      
      // 本地状态过滤
      if (stateFilter === 'enabled' || stateFilter === 'active') {
        const stoppedStatuses = ['CAMPAIGN_PAUSED', 'CAMPAIGN_ARCHIVED', 'PORTFOLIO_ENDED'];
        allCampaigns = allCampaigns.filter(c => !stoppedStatuses.includes(c.serving_status));
      }
      
      // 保存状态过滤后的全量（用于回退）
      const stateFilteredFullSet = allCampaigns.slice();
      
      // portfolio 过滤
      if (pid) {
        const pf = allCampaigns.filter(c => String(c.portfolio_id || c.portfolioId) === String(pid));
        if (pf.length > 0) {
          allCampaigns = pf;
        } else if (!rawCampaigns.some(c => String(c.portfolio_id || c.portfolioId) === String(pid))) {
          allCampaigns = stateFilteredFullSet;
        } else {
          // 全量中有该组合的活动，但被状态过滤掉了 → 返回空数组
          allCampaigns = [];
        }
      }
      
      return sendJSON(res, { campaigns: allCampaigns, total: allCampaigns.length });
    }

    // === 关键词数据 ===
    if (parts[0] === 'keywords' && method === 'GET' && parts.length === 1) {
      try {
      if (!query.sid || !query.campaign_id) return sendError(res, '缺少 sid 或 campaign_id');
      const sid = Number(query.sid);
      const campaignId = Number(query.campaign_id);
      const days = Math.min(parseInt(query.days) || 7, 90);

      // 计算日期范围
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      function fmtDate(d) { return d.toISOString().slice(0, 10); }

      // 获取活动详情（同时查 SP 和 SB/HSA 活动类型）
      let campaignData = {};
      let campaignType = 'sp'; // 'sp' | 'sb' | 'sd'
      try {
        const campResult = await callLingXingApi('/pb/openapi/newad/spCampaigns', 'POST', {
          sid, offset: 0, length: 500
        });
        const found = (campResult.data || []).find(c => String(c.campaign_id) === String(campaignId));
        if (found) campaignData = found;
      } catch (e) {}
      // 如果 SP 没找到，尝试 SB(HSA)
      if (!campaignData.campaign_id) {
        try {
          const hsaResult = await callLingXingApi('/pb/openapi/newad/hsaCampaigns', 'POST', {
            sid, offset: 0, length: 2000
          });
          const found = (hsaResult.data || []).find(c => String(c.campaign_id) === String(campaignId));
          if (found) {
            campaignData = found;
            campaignType = 'sb';
          }
        } catch (e) {}
      }
      // 如果还找不到，尝试 SD
      if (!campaignData.campaign_id) {
        try {
          const sdResult = await callLingXingApi('/pb/openapi/newad/sdCampaigns', 'POST', {
            sid, offset: 0, length: 2000
          });
          const found = (sdResult.data || []).find(c => String(c.campaign_id) === String(campaignId));
          if (found) {
            campaignData = found;
            campaignType = 'sd';
          }
        } catch (e) {}
      }

      const servingStatus = campaignData.serving_status || '';
      let keywordsMap = {}; // keywordId → combined data

      if (campaignType === 'sp') {
        // === SP 活动：关键词 + 商品定位 ===

        // 1) 拉取 SP 关键词设置
        try {
          const kwSettings = await callLingXingApi('/pb/openapi/newad/spKeywords', 'POST', {
            sid, offset: 0, length: 25000
          });
          const kwData = kwSettings.data || [];
          for (const kw of Array.isArray(kwData) ? kwData : []) {
            if (kw.keyword_id && String(kw.campaign_id) === String(campaignId)) {
              keywordsMap[kw.keyword_id] = {
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text || '',
                match_type: kw.match_type || '',
                state: kw.state || '',
                bid: kw.bid || 0,
                impressions: 0, clicks: 0, cost: 0, sales: 0,
                campaign_name: campaignData.name || '',
                campaign_type: 'sp',
                target_type: 'keyword'
              };
            }
          }
        } catch (e) {
          console.error('获取关键词设置失败:', e.message);
        }

        // 2) 拉取 SP 商品定位（ASIN 定位）
        try {
          const targetSettings = await callLingXingApi('/pb/openapi/newad/spTargets', 'POST', {
            sid, offset: 0, length: 5000
          });
          const tData = targetSettings.data || [];
          for (const t of Array.isArray(tData) ? tData : []) {
            if (t.target_id && String(t.campaign_id) === String(campaignId)) {
              let asin = '';
              try {
                const exp = typeof t.expression === 'string' ? JSON.parse(t.expression) : t.expression || [];
                if (Array.isArray(exp) && exp[0]?.value) asin = exp[0].value;
              } catch (e) {}
              if (!asin) {
                try {
                  const exp = typeof t.resolved_expression === 'string' ? JSON.parse(t.resolved_expression) : t.resolved_expression || [];
                  if (Array.isArray(exp) && exp[0]?.value) asin = exp[0].value;
                } catch (e) {}
              }
              keywordsMap['t_' + t.target_id] = {
                keyword_id: t.target_id,
                keyword_text: asin || '(ASIN)',
                match_type: 'ASIN',
                state: t.state || '',
                bid: t.bid || 0,
                impressions: 0, clicks: 0, cost: 0, sales: 0,
                campaign_name: campaignData.name || '',
                campaign_type: 'sp',
                target_type: 'asin'
              };
            }
          }
        } catch (e) {
          console.error('获取商品定位失败:', e.message);
        }

        // 3) 逐日 SP 报告
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
          const dateStr = fmtDate(d);
          // ——— 关键词报告 ———
          try {
            const report = await callLingXingApi('/pb/openapi/newad/spKeywordReports', 'POST', {
              sid, offset: 0, length: 5000, report_date: dateStr
            });
            const rows = report.data || [];
            for (const row of Array.isArray(rows) ? rows : []) {
              const kid = row.keyword_id;
              if (!kid) continue;
              if (!keywordsMap[kid]) continue;
              keywordsMap[kid].impressions += (row.impressions || 0);
              keywordsMap[kid].clicks += (row.clicks || 0);
              keywordsMap[kid].cost += (row.cost || 0);
              keywordsMap[kid].sales += (row.sales || 0);
              if (row.bid) keywordsMap[kid].bid = row.bid;
              if (row.state) keywordsMap[kid].state = row.state;
            }
          } catch (e) {}
          // ——— 商品定位报告（ASIN 表现） ———
          try {
            const report = await callLingXingApi('/pb/openapi/newad/spTargetReports', 'POST', {
              sid, offset: 0, length: 5000, report_date: dateStr
            });
            const rows = report.data || [];
            for (const row of Array.isArray(rows) ? rows : []) {
              const tid = row.target_id;
            if (!tid) continue;
            const key = 't_' + tid;
            if (!keywordsMap[key]) continue;
            keywordsMap[key].impressions += (row.impressions || 0);
            keywordsMap[key].clicks += (row.clicks || 0);
            keywordsMap[key].cost += (row.cost || 0);
            keywordsMap[key].sales += (row.sales || 0);
            if (row.bid) keywordsMap[key].bid = row.bid;
            if (row.state) keywordsMap[key].state = row.state;
          }
        } catch (e) {}
      }

    } // end of SP

    // === SB/SBV 活动：sbTargeting（关键词 + 商品定位）===
    if (campaignType === 'sb') {
      const profile_id = campaignData.profile_id || campaignData.profileId || campaignData.profileId_accountId;
      console.log('SB关键词: campaignId='+campaignId+' sid='+sid+' profile_id='+profile_id+' profileId='+campaignData.profileId+
        ' profile_id_raw='+campaignData.profile_id+' campaignData keys='+Object.keys(campaignData).join(','));

      // 1) sbTargeting 拉取SB关键词（用targeting_type='keyword'避免分页截断）
      const sbItems = [];
      try {
        for (let pg = 0; pg < 10; pg++) {
          const sbRes = await callLingXingApi('/pb/openapi/newad/sbTargeting', 'POST', {
            sid, profile_id, ads_type: 'ALL', targeting_type: 'keyword', offset: pg * 5000, length: 5000
          });
          const pageItems = sbRes.data || [];
          if (!Array.isArray(pageItems) || pageItems.length === 0) break;
          sbItems.push(...pageItems);
        }
        const items = sbItems;
        if (Array.isArray(items) && items.length > 0) {
          // 打印第1个匹配项的所有字段以便调试bid
          const firstMatch = items.find(it => String(it.campaign_id) === String(campaignId));
          if (firstMatch) {
            console.log('sbTargeting first match fields:', JSON.stringify(Object.keys(firstMatch)), 'bid:', firstMatch.bid, 'keywordBid:', firstMatch.keywordBid, 'keyword_bid:', firstMatch.keyword_bid, 'suggested_bid:', firstMatch.suggested_bid);
          }
        }
        for (const it of Array.isArray(items) ? items : []) {
          const tid = it.target_id || it.keyword_id;
          if (!tid || String(it.campaign_id) !== String(campaignId)) continue;
          const isKeyword = it.targeting_type === 'keyword';
          const key = isKeyword ? String(tid) : 't_' + String(tid);
          // 解析SB/SBV投放表达式提取ASIN
          let asinText = '';
          if (!isKeyword) {
            const rawExp = it.expression || '';
            try {
              const expArr = typeof rawExp === 'string' ? JSON.parse(rawExp) : rawExp;
              if (Array.isArray(expArr) && expArr[0]?.value) {
                asinText = expArr[0].value;
              }
            } catch (e) {
              asinText = rawExp || '';
            }
            if (!asinText) asinText = it.target_asin || '(ASIN)';
          }
          // sbTargeting 使用 keyword_bid/keyword_state 字段（非 bid/state）
          let kwBid = isKeyword ? (it.keyword_bid || 0) : (it.target_bid || 0);
          if (!kwBid) kwBid = it.bid || 0;
          let kwState = isKeyword ? (it.keyword_state || '') : (it.target_state || '');
          if (!kwState) kwState = it.state || '';
          if (!kwState) kwState = 'enabled';
          keywordsMap[key] = {
            keyword_id: tid,
            keyword_text: isKeyword ? (it.keyword_text || it.keyword || '') : asinText,
            match_type: isKeyword ? (it.match_type || '') : 'ASIN',
            state: kwState,
            bid: kwBid,
            impressions: 0, clicks: 0, cost: 0, sales: 0,
            campaign_name: campaignData.name || '',
            campaign_type: 'sb',
            target_type: isKeyword ? 'keyword' : 'asin'
          };
        }
      } catch (e) {
        console.error('获取SB投放设置失败:', e.message);
      }

      // 2) 逐日报告：hsaQueryWordReports + sbDivideAsinReports
      const profile_id_num = Number(profile_id) || 0;
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = fmtDate(d);
        // 关键词报告
        try {
          const report = await callLingXingApi('/pb/openapi/newad/hsaQueryWordReports', 'POST', {
            sid, profile_id: profile_id_num, target_type: 'keyword', offset: 0, length: 5000, report_date: dateStr
          });
          const rows = report.data || [];
          for (const row of Array.isArray(rows) ? rows : []) {
            const kid = row.keyword_id || row.target_id;
            if (!kid) continue;
            if (!keywordsMap[kid]) continue;
            const kw = keywordsMap[kid];
            kw.impressions += (row.impressions || row.campaignImpressions || 0);
            kw.clicks += (row.clicks || row.campaignClicks || 0);
            kw.cost += (row.cost || row.campaignCost || 0);
            kw.sales += (row.sales || 0);
            const dailyBid = row.keyword_bid || row.bid || 0;
            if (dailyBid) kw.bid = dailyBid;
            const dailyState = row.keyword_state || row.state || '';
            if (dailyState) kw.state = dailyState;
          }
        } catch (e) {}
        // ASIN 分投报告
        try {
          const report = await callLingXingApi('/pb/openapi/newad/sbDivideAsinReports', 'POST', {
            sid, profile_id: profile_id_num, offset: 0, length: 5000, report_date: dateStr
          });
          const rows = report.data || [];
          for (const row of Array.isArray(rows) ? rows : []) {
            const tid = row.target_id;
            if (!tid) continue;
            const key = 't_' + String(tid);
            if (!keywordsMap[key]) continue;
            const kw = keywordsMap[key];
            kw.impressions += (row.impressions || row.campaignImpressions || 0);
            kw.clicks += (row.clicks || row.campaignClicks || 0);
            kw.cost += (row.cost || row.campaignCost || 0);
            kw.sales += (row.sales || 0);
          }
        } catch (e) {}
      }
    } // end of SB

    // ========== 汇总计算（SP 和 SB 共用） ==========
    const keywords = Object.values(keywordsMap).map(kw => {
      const ctr = kw.impressions > 0 ? (kw.clicks / kw.impressions * 100) : 0;
      const acos = kw.sales > 0 ? (kw.cost / kw.sales * 100) : 0;
      const cpc = kw.clicks > 0 ? (kw.cost / kw.clicks) : 0;
      return {
        ...kw,
        impressions: kw.impressions,
        clicks: kw.clicks,
        ctr: Math.round(ctr * 100) / 100,
        cost: Math.round(kw.cost * 100) / 100,
        sales: Math.round(kw.sales * 100) / 100,
        acos: Math.round(acos * 100) / 100,
        cpc: Math.round(cpc * 100) / 100,
        orders: Math.round(kw.sales / (campaignData.avg_price || 20) * 100) / 100
      };
    }).sort((a, b) => b.cost - a.cost);

    // 附加上次修改记录
    const latestChanges = loadChangeMap();
    for (const kw of keywords) {
      const histKey = (kw.target_type === 'asin' ? 'target_' : 'keyword_') + kw.keyword_id;
      if (latestChanges[histKey]) {
        kw.last_change = latestChanges[histKey];
      }
    }

    // 最多返回 200 个关键词
    return sendJSON(res, { keywords: keywords.slice(0, 200), campaign: campaignData });
    } catch (e) {
      console.error('Keywords route error:', e.message, e.stack);
      return sendJSON(res, { error: '关键词查询异常: ' + (e.message || e) }, 500);
    }
    }

    // === 卖家精灵关键词市场数据 ===
    if (parts[0] === 'sellersprite' && parts[1] === 'keyword' && method === 'GET') {
      if (!query.keyword) return sendError(res, '缺少 keyword 参数');
      try {
        const result = await callSellerspriteTool('keyword_research_trends', {
          keyword: query.keyword,
          marketplace: query.marketplace || 'US'
        });
        return sendJSON(res, result.result || result);
      } catch (e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // === 批量查询卖家精灵关键词（带本地缓存） ===
    if (parts[0] === 'sellersprite' && parts[1] === 'keywords-batch' && method === 'POST') {
      const body = await readBody();
      const { keywords: kwList, marketplace } = body;
      if (!kwList || !Array.isArray(kwList) || kwList.length === 0) return sendError(res, '缺少 keywords 数组');
      
      // 加载本地缓存（24小时自动过期）
      const CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
      let ssCache = {};
      try { ssCache = JSON.parse(fs.readFileSync(SS_CACHE_PATH, 'utf8')); } catch(e) { ssCache = {}; }
      // 清除过期缓存（保留元数据字段）
      const now = Date.now();
      let expiredCount = 0;
      for (const k of Object.keys(ssCache)) {
        if (k.startsWith('_')) continue; // 跳过元数据
        if (!ssCache[k]._ts || (now - ssCache[k]._ts) > CACHE_TTL) {
          delete ssCache[k];
          expiredCount++;
        }
      }
      if (expiredCount > 0) console.log(`SS缓存过期清理: ${expiredCount}条`);
      
      const quotaExhausted = ssCache._quota_exhausted === true;
      let newQuotaExhausted = false;
      
      try {
        const results = {};
        const list = kwList.slice(0, 30);
        
        for (let idx = 0; idx < list.length; idx++) {
          const kw = list[idx];
          const key = kw.toLowerCase();
          
          // 命中缓存直接返回，不消耗API
          if (ssCache[key] && !quotaExhausted) {
            results[key] = ssCache[key];
            continue;
          }
          if (quotaExhausted) {
            results[key] = ssCache[key] || { search_vol: '—', competition: '—', market_cpc: '—', market_cpc_min: '—', market_cpc_max: '—', purchases: '—', growth: '—', products: '—', supply_demand_ratio: '—', ara_click_rate: '—', avg_price: '—' };
            continue;
          }
          
          if (idx > 0) await new Promise(r => setTimeout(r, 500));
          try {
            const raw = await callSellerspriteTool('keyword_research', {
              request: { marketplace: marketplace || 'US', keywords: kw, size: 50 }
            });
            
            // 检测额度耗尽
            const rawText = raw?.result?.content?.[0]?.text || '';
            if (rawText.includes('ERROR_UNAUTHORIZED') || rawText.includes('secret_no_remaining')) {
              newQuotaExhausted = true;
              ssCache._quota_exhausted = true;
              // 把已缓存结果设为默认值
              results[key] = { search_vol: '—', competition: '—', market_cpc: '—', market_cpc_min: '—', market_cpc_max: '—', purchases: '—', growth: '—', products: '—', supply_demand_ratio: '—', ara_click_rate: '—', avg_price: '—' };
              // 标记本次返回，不再继续请求后面的关键词
              for (let r = idx + 1; r < list.length; r++) {
                const rk = list[r].toLowerCase();
                results[rk] = ssCache[rk] || { search_vol: '—', competition: '—', market_cpc: '—', market_cpc_min: '—', market_cpc_max: '—', purchases: '—', growth: '—', products: '—', supply_demand_ratio: '—', ara_click_rate: '—', avg_price: '—' };
              }
              break;
            }
            
            // 解析关键词搜索结果
            let items = [];
            try {
              const parsed = JSON.parse(rawText);
              items = parsed?.data?.items || [];
            } catch (e) { items = []; }
            
            const match = Array.isArray(items) ? items.find(i => (i.keywords || '').toLowerCase() === key.toLowerCase()) : null;
            
            if (match) {
              const searches = match.searches || null;
              const purchaseRate = match.purchaseRate || null;
                const bidMin = match.bidMin;
              const bidMax = match.bidMax;
              const bid = match.bid;
              
              let competition = null;
              if (purchaseRate !== null && purchaseRate > 0) {
                competition = (Math.min(1, Math.max(0, 1 - purchaseRate)) * 100).toFixed(0) + '%';
              }
              
              const entry = {
                search_vol: searches ? Number(searches).toLocaleString() : '—',
                competition: competition || '—',
                market_cpc: bid || '—',
                market_cpc_min: bidMin || '—',
                market_cpc_max: bidMax || '—',
                purchases: typeof match.purchases === 'number' ? Number(match.purchases).toLocaleString() : '—',
                growth: typeof match.growth === 'number' ? match.growth : '—',
                products: typeof match.products === 'number' ? match.products : '—',
                supply_demand_ratio: typeof match.supplyDemandRatio === 'number' ? match.supplyDemandRatio : '—',
                ara_click_rate: typeof match.araClickRate === 'number' ? match.araClickRate : '—',
                avg_price: typeof match.avgPrice === 'number' ? match.avgPrice : '—',
                _ts: Date.now()
              };
              results[key] = entry;
              ssCache[key] = entry;
            } else {
              // 回退到 trends（仅获取搜索量）
              let fallbackEntry = { search_vol: '—', competition: '—', market_cpc: '—', market_cpc_min: '—', market_cpc_max: '—', purchases: '—', growth: '—', products: '—', supply_demand_ratio: '—', ara_click_rate: '—', avg_price: '—' };
              try {
                const fb = await callSellerspriteTool('keyword_research_trends', {
                  marketplace: marketplace || 'US', keyword: kw
                });
                const fbText = fb?.result?.content?.[0]?.text || '{}';
                if (!fbText.includes('ERROR_UNAUTHORIZED')) {
                  const fbItems = JSON.parse(fbText)?.data || [];
                  if (fbItems.length > 0) {
                    const latest = fbItems[fbItems.length - 1];
                    const fv = latest.search || latest.searches || null;
                    if (fv) fallbackEntry.search_vol = Number(fv).toLocaleString();
                  }
                }
              } catch (e) { /* 静默 */ }
              results[key] = fallbackEntry;
              fallbackEntry._ts = Date.now();
              ssCache[key] = fallbackEntry;
            }
          } catch (e) {
            results[kw.toLowerCase()] = { search_vol: '—', competition: '—', market_cpc: '—', market_cpc_min: '—', market_cpc_max: '—', purchases: '—', growth: '—', products: '—', supply_demand_ratio: '—', ara_click_rate: '—', avg_price: '—', _ts: Date.now() };
          }
        }
        
        // 持久化缓存
        if (!quotaExhausted) {
          try { fs.writeFileSync(SS_CACHE_PATH, JSON.stringify(ssCache, null, 2)); } catch(e) {}
        }
        
        return sendJSON(res, { data: results, quota_exhausted: newQuotaExhausted || quotaExhausted });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // === 关键词/ASIN操作（更新竞价/暂停） ===
    if (parts[0] === 'keywords' && parts[1] === 'action' && method === 'POST') {
      const body = await readBody();
      const { sid, profile_id, keywords: kwActions, target_type } = body;
      if (!kwActions || !Array.isArray(kwActions)) return sendError(res, '缺少 keywords 数组');

      const isAsin = target_type === 'asin';
      let result;

      if (isAsin) {
        // SP 商品投放操作：managePutSpTarget
        const params = {};
        if (sid) params.sid = Number(sid);
        if (profile_id) params.profile_id = Number(profile_id);
        params.targetingClauses = kwActions.map(k => {
          const item = { targetId: Number(k.keywordId) };
          if (k.state) item.state = k.state;
          if (k.bid !== undefined) {
            item.bid = Number(k.bid);
            item.isBaseValue = 1;
            item.baseType = 1;
            item.baseValue = Number(k.bid);
          } else {
            item.isBaseValue = 0;
          }
          return item;
        });
        result = await callLingXingApi('/basicOpen/adReport/manage/putSpTarget', 'POST', params);
      } else {
        // SP 关键词操作：managePutSpKeyword
        const params = {};
        if (sid) params.sid = Number(sid);
        if (profile_id) params.profile_id = Number(profile_id);
        params.keywords = kwActions.map(k => {
          const item = {};
          item.keywordId = Number(k.keywordId);
          if (k.state) item.state = k.state;
          if (k.bid !== undefined) {
            item.bid = Number(k.bid);
            item.isBaseValue = 1;
            item.baseType = 1;
            item.baseValue = Number(k.bid);
          } else {
            item.isBaseValue = 0;
          }
          return item;
        });
        result = await callLingXingApi('/basicOpen/adReport/manage/putSpKeyword', 'POST', params);
      }

      // 记录修改历史
      const timestamp = new Date().toISOString();
      const prefix = isAsin ? 'target_' : 'keyword_';
      for (const action of kwActions) {
        const changes = {};
        if (action.state) {
          changes.state = { to: action.state };
        }
        if (action.bid !== undefined) {
          const fromBid = action.current_bid !== undefined ? Number(action.current_bid) : undefined;
          changes.bid = { from: fromBid, to: Number(action.bid) };
        }
        const entry = {
          id: prefix + action.keywordId,
          keyword_text: action.keyword_text || '',
          target_type: target_type || 'keyword',
          timestamp,
          changes
        };
        saveChange(entry.id, entry);
      }

      return sendJSON(res, { success: true, data: result.data });
    }

    // === 批量关键词AI分析 ===
    if (parts[0] === 'keyword' && parts[1] === 'batch-analyze' && method === 'POST') {
      const body = await readBody();
      const { sid, campaign_id, keywords: kwList } = body;
      if (!sid || !campaign_id || !kwList || !Array.isArray(kwList) || kwList.length === 0) {
        return sendError(res, '缺少sid/campaign_id或keywords数组为空');
      }

      // 1) 查找活动信息（一次）
      let campaignType = 'sp', campaignProfileId = 0, campaignBudget = null, campaignServingStatus = '';
      for (const { type, api } of [
        { type: 'sp', api: '/pb/openapi/newad/spCampaigns' },
        { type: 'sb', api: '/pb/openapi/newad/hsaCampaigns' },
        { type: 'sd', api: '/pb/openapi/newad/sdCampaigns' }
      ]) {
        if (campaignProfileId) break;
        try {
          const r = await callLingXingApi(api, 'POST', { sid, offset: 0, length: 500 });
          const found = (r.data || []).find(c => String(c.campaign_id) === String(campaign_id));
          if (found) {
            campaignType = type;
            campaignProfileId = found.profile_id || 0;
            campaignBudget = found.budget != null ? Number(found.budget) : null;
            campaignServingStatus = found.serving_status || '';
          }
        } catch(e){}
      }

      // 2) 批量获取30d/60d报告，索引化
      const endDate = new Date();
      function dateRange(days) {
        const dates = [];
        const start = new Date(); start.setDate(start.getDate() - days);
        for (let d = new Date(start); d <= endDate; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));
        return dates;
      }

      async function fetchReportsByMonth(days) {
        const dates = dateRange(days);
        const rows = await Promise.all(dates.map(async ds => {
          try {
            let r;
            if (campaignType === 'sb') {
              r = await callLingXingApi('/pb/openapi/newad/hsaQueryWordReports', 'POST', {
                sid, profile_id: campaignProfileId, target_type: 'keyword',
                offset: 0, length: 5000, report_date: ds
              });
            } else {
              r = await callLingXingApi('/pb/openapi/newad/spKeywordReports', 'POST',
                { sid, offset: 0, length: 5000, report_date: ds });
            }
            return r.data || [];
          } catch(e) { return []; }
        }));
        return rows.flat();
      }

      const [allRows30, allRows60] = await Promise.all([
        fetchReportsByMonth(30),
        fetchReportsByMonth(60)
      ]);

      // 按 keyword_id 索引所有行
      function indexReports(rows) {
        const map = {};
        for (const row of rows) {
          const kid = row.keyword_id || row.target_id;
          if (!kid) continue;
          const sk = String(kid);
          if (!map[sk]) map[sk] = { impressions:0, clicks:0, cost:0, sales:0 };
          map[sk].impressions += row.impressions || 0;
          map[sk].clicks += row.clicks || 0;
          map[sk].cost += row.cost || 0;
          map[sk].sales += row.sales || 0;
        }
        return map;
      }
      const index30 = indexReports(allRows30);
      const index60 = indexReports(allRows60);

      function getReport(keywordId, idx) {
        const d = idx[String(keywordId)] || { impressions:0, clicks:0, cost:0, sales:0 };
        return {
          impressions: d.impressions, clicks: d.clicks, cost: d.cost, sales: d.sales,
          ctr: d.impressions > 0 ? d.clicks / d.impressions * 100 : 0,
          cpc: d.clicks > 0 ? d.cost / d.clicks : 0,
          acos: d.sales > 0 ? d.cost / d.sales * 100 : 0
        };
      }

      // 3) 并发处理每个关键词（限制并发3）
      const results = [];

      async function processOne(kw) {
        let ssData = kw.ssData || {};

        // 转换ssData数值
        const enrichedSs = { ...ssData };
        if (enrichedSs.growth === undefined || enrichedSs.growth === null || enrichedSs.growth === '—') enrichedSs.growth = null;
        else enrichedSs.growth = Number(enrichedSs.growth);
        if (enrichedSs.search_monthly_cr === undefined || enrichedSs.search_monthly_cr === null || enrichedSs.search_monthly_cr === '—') enrichedSs.search_monthly_cr = null;
        else enrichedSs.search_monthly_cr = Number(enrichedSs.search_monthly_cr);
        if (enrichedSs.search_nearly_cr === undefined || enrichedSs.search_nearly_cr === null || enrichedSs.search_nearly_cr === '—') enrichedSs.search_nearly_cr = null;
        else enrichedSs.search_nearly_cr = Number(enrichedSs.search_nearly_cr);

        const d30 = getReport(kw.keyword_id, index30);
        const d60 = getReport(kw.keyword_id, index60);

        const engineResult = analyzeKeyword(enrichedSs, d30, d60, {
          current_bid: kw.current_bid || 0,
          keyword_text: kw.keyword_text || '',
          campaign_type: campaignType,
          target_type: kw.target_type || 'keyword',
          daily_budget: campaignBudget,
          serving_status: campaignServingStatus
        });

        return {
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword_text,
          score: engineResult.score,
          score_label: engineResult.scoreLabel,
          summary: engineResult.summary,
          suggestions: engineResult.suggestions,
          details: engineResult.analysis,
          analysis_30d: d30,
          current_bid: kw.current_bid || 0
        };
      }

      // 并行处理，控制并发
      const concurrency = 3;
      for (let i = 0; i < kwList.length; i += concurrency) {
        const chunk = kwList.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(kw => processOne(kw)));
        results.push(...chunkResults);
      }

      return sendJSON(res, { results });
    }

    if (parts[0] === 'keyword' && parts[1] === 'analyze' && method === 'POST') {
      const body = await readBody();
      const { sid, campaign_id, keyword_id, keyword_text, marketplace, target_type } = body;
      if (!keyword_id || !keyword_text) return sendError(res, '缺少 keyword_id 或 keyword_text');

      try {
        // 判断活动类型（SP/SB/SD）并获取 profile_id、预算、投放状态
        let campaignType = 'sp';
        let campaignProfileId = 0;
        let campaignBudget = null;
        let campaignServingStatus = '';
        if (campaign_id) {
          for (const { type, api } of [
            { type: 'sp', api: '/pb/openapi/newad/spCampaigns' },
            { type: 'sb', api: '/pb/openapi/newad/hsaCampaigns' },
            { type: 'sd', api: '/pb/openapi/newad/sdCampaigns' }
          ]) {
            if (campaignProfileId) break;
            try {
              const r = await callLingXingApi(api, 'POST', { sid, offset: 0, length: 500 });
              const found = (r.data || []).find(c => String(c.campaign_id) === String(campaign_id));
              if (found) {
                campaignType = type;
                campaignProfileId = found.profile_id || 0;
                campaignBudget = found.budget != null ? Number(found.budget) : null;
                campaignServingStatus = found.serving_status || '';
              }
            } catch(e){}
          }
        }

        // 1) 获取30天和60天报告数据（并行查询每一天，大幅提速）
        const endDate = new Date();
        // 生成日期列表 [start, end] 闭区间
        function dateRange(days) {
          const dates = [];
          const start = new Date(); start.setDate(start.getDate() - days);
          for (let d = new Date(start); d <= endDate; d.setDate(d.getDate() + 1)) {
            dates.push(d.toISOString().slice(0, 10));
          }
          return dates;
        }
        async function getReports(days) {
          const dates = dateRange(days);
          // 并行查询每一天
          const results = await Promise.all(dates.map(async (ds) => {
            try {
              if (campaignType === 'sb') {
                const r = await callLingXingApi('/pb/openapi/newad/hsaQueryWordReports', 'POST', {
                  sid, profile_id: campaignProfileId, target_type: target_type === 'asin' ? 'producttarget' : 'keyword',
                  offset: 0, length: 5000, report_date: ds
                });
                return r.data || [];
              } else if (target_type === 'asin') {
                const r = await callLingXingApi('/pb/openapi/newad/spTargetReports', 'POST',
                  { sid, offset: 0, length: 5000, report_date: ds });
                return r.data || [];
              } else {
                const r = await callLingXingApi('/pb/openapi/newad/spKeywordReports', 'POST',
                  { sid, offset: 0, length: 5000, report_date: ds });
                return r.data || [];
              }
            } catch (e) { return []; }
          }));
          // 汇总
          let impressions = 0, clicks = 0, cost = 0, sales = 0;
          for (const rows of results) {
            for (const row of Array.isArray(rows) ? rows : []) {
              const matchId = row.keyword_id || row.target_id;
              if (String(matchId) === String(keyword_id)) {
                impressions += row.impressions || 0;
                clicks += row.clicks || 0;
                cost += row.cost || 0;
                sales += row.sales || 0;
              }
            }
          }
          return { impressions, clicks, cost, sales,
            ctr: impressions > 0 ? clicks / impressions * 100 : 0,
            cpc: clicks > 0 ? cost / clicks : 0,
            acos: sales > 0 ? cost / sales * 100 : 0
          };
        }

        const [d30, d60] = await Promise.all([
          getReports(30),
          getReports(60)
        ]);

        // 2) 卖家精灵数据
        let ssData = {};
        if (keyword_text && target_type !== 'asin') {
          try {
            const raw = await callSellerspriteTool('keyword_research', {
              request: { marketplace: marketplace || 'US', keywords: keyword_text, size: 50 }
            });
            const contentArr = raw?.result?.content || [];
            const text = contentArr[0]?.text || '{}';
            const parsed = JSON.parse(text);
            const items = parsed?.data?.items || [];
            const match = Array.isArray(items)
              ? items.find(i => (i.keywords || '').toLowerCase() === keyword_text.toLowerCase())
              : null;
            if (match) {
              ssData = {
                // 搜索数据
                search_vol: match.searches || '—',
                purchase_rate: match.purchaseRate || '—',
                products: match.products || '—',
                market_cpc: match.bid != null ? Number(match.bid).toFixed(2) : '—',
                bid_min: match.bidMin != null ? Number(match.bidMin).toFixed(2) : '—',
                bid_max: match.bidMax != null ? Number(match.bidMax).toFixed(2) : '—',
                // 趋势数据
                growth: match.growth,
                search_monthly_cr: match.searchMonthlyCr,
                search_monthly_cv: match.searchMonthlyCv,
                search_nearly_cr: match.searchNearlyCr,
                search_nearly_cv: match.searchNearlyCv,
                market_period: match.marketPeriod || '—',
                // 竞争格局
                competition: match.purchaseRate != null ? (1 - match.purchaseRate).toFixed(2) : '—',
                supply_demand_ratio: match.supplyDemandRatio,
                title_density_exact: match.titleDensityExact || 0,
                // 价格与评价
                avg_price: match.avgPrice != null ? Number(match.avgPrice).toFixed(2) : '—',
                avg_rating: match.avgRating || '—',
                avg_ratings: match.avgRatings || '—',
                // ARA广告数据
                ara_click_rate: match.araClickRate,
                ara_share_rate: match.araShareRate,
                num_competing_asins: (match.araAsinList || []).length,
                competing_asins_top: (match.araAsinList || []).slice(0, 3).map(a => ({ asin: a.asin, cr: a.clickRate })),
                // 品牌数据
                brands: match.brands || [],
                has_brand_word: match.hasBrandWord || false,
                keyword_cn: match.keywordCn || '—',
                // 原始搜索表现
                search_impressions: match.impressions || 0,
                search_clicks: match.clicks || 0,
                search_purchases: match.purchases || 0
              };
            }
          } catch (e) {}
        }

        // 3) 生成AI分析 — 使用新版分析引擎
        // 将ssData中的数值字符串转为数字，引擎需要
        const enrichedSs = { ...ssData };
        if (enrichedSs.growth === undefined || enrichedSs.growth === null || enrichedSs.growth === '—') enrichedSs.growth = null;
        else enrichedSs.growth = Number(enrichedSs.growth);
        if (enrichedSs.search_monthly_cr === undefined || enrichedSs.search_monthly_cr === null || enrichedSs.search_monthly_cr === '—') enrichedSs.search_monthly_cr = null;
        else enrichedSs.search_monthly_cr = Number(enrichedSs.search_monthly_cr);
        if (enrichedSs.search_nearly_cr === undefined || enrichedSs.search_nearly_cr === null || enrichedSs.search_nearly_cr === '—') enrichedSs.search_nearly_cr = null;
        else enrichedSs.search_nearly_cr = Number(enrichedSs.search_nearly_cr);

        const engineResult = analyzeKeyword(enrichedSs, d30, d60, {
          current_bid: body.current_bid || 0,
          keyword_text: body.keyword_text || '',
          campaign_type: campaignType || 'sp',
          target_type: body.target_type || 'keyword',
          daily_budget: campaignBudget,
          serving_status: campaignServingStatus
        });

        return sendJSON(res, {
          keyword_text,
          analysis_30d: d30,
          analysis_60d: d60,
          sellersprite: ssData,
          current_bid: body.current_bid || 0,
          details: engineResult.analysis,
          suggestions: engineResult.suggestions,
          summary: engineResult.summary,
          score: engineResult.score,
          score_label: engineResult.scoreLabel
        });
      } catch (e) {
        return sendError(res, '分析出错: ' + e.message, 500);
      }
    }

    // ============================================================
    // Listing 编辑
    // ============================================================
    if (parts[0] === 'listing' && parts[1] === 'query' && method === 'POST') {
      const body = await readBody();
      const { store_id, seller_skus } = body;
      if (!store_id || !seller_skus || !seller_skus.length) {
        return sendError(res, '缺少 store_id 或 seller_skus');
      }

      try {
        // 查询店铺名称
        let storeName = String(store_id);
        try {
          const storeResult = await callLingXingApi('/erp/sc/data/seller/lists', 'GET');
          const storeList = storeResult.data || [];
          if (Array.isArray(storeList)) {
            const found = storeList.find(s => String(s.sid) === String(store_id));
            if (found && found.name) storeName = found.name;
          }
        } catch (se) { /* 店铺名称查询失败不阻断 */ }

        // 查询已有商品信息
        const result = await callLingXingApi('/listing/publish/openapi/amazon/product/search', 'POST', {
          store_id: Number(store_id),
          skus: seller_skus.slice(0, 20)  // 最多20个
        });

        if (result.code !== 1) {
          return sendError(res, result.msg || '查询失败', 500);
        }

        // 提取关键字段
        const listings = (result.data || []).map(item => {
          const attrs = item.info?.attributes || {};
          const summary = (item.info?.summaries || [])[0] || {};

          // 取 en_US 的 title（优先），fallback 到第一个
          const titleEntry = (attrs.item_name || []).find(a => a.language_tag === 'en_US') || (attrs.item_name || [])[0];
          const descEntry = (attrs.product_description || []).find(a => a.language_tag === 'en_US') || (attrs.product_description || [])[0];

          // bullet points：只取 en_US
          const bullets = (attrs.bullet_point || [])
            .filter(a => a.language_tag === 'en_US')
            .map(a => a.value);

          // search terms：只取 en_US
          const searchTerms = (attrs.generic_keyword || [])
            .filter(a => a.language_tag === 'en_US')
            .map(a => a.value);

          // 图片
          const images = [];
          for (let i = 1; i <= 7; i++) {
            const key = `other_product_image_locator_${i}`;
            const img = (attrs[key] || [])[0];
            if (img?.media_location) images.push({ slot: i, url: img.media_location });
          }
          const mainImg = (attrs.main_product_image_locator || [])[0];

          return {
            seller_sku: item.msku,
            asin: summary.asin || '',
            product_type: summary.productType || '',
            marketplace_id: summary.marketplaceId || '',
            title: titleEntry?.value || '',
            brand: ((attrs.brand || []).find(a => a.language_tag === 'en_US') || (attrs.brand || [])[0])?.value || '',
            bullet_points: bullets,
            product_description: descEntry?.value || '',
            backend_search_terms: searchTerms,
            main_image: mainImg?.media_location || '',
            other_images: images,
            status: summary.status || []
          };
        });

        // 查询父体 ASIN（批量搜索子ASIN的父体信息）
        try {
          const asins = listings.map(l => l.asin).filter(Boolean);
          if (asins.length > 0) {
            const parentResult = await callLingXingApi('/bd/productPerformance/openApi/asinList', 'POST', {
              offset: 0, length: asins.length,
              sort_field: 'volume', sort_type: 'desc',
              search_field: 'asin', search_value: asins,
              sid: [Number(store_id)],
              start_date: new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
              end_date: new Date().toISOString().split('T')[0],
              summary_field: 'asin',
              is_recently_enum: false
            });
            if (parentResult.code === 0 && parentResult.data?.list) {
              const parentMap = {};
              for (const item of parentResult.data.list) {
                // 领星返回 asins 可能是对象数组，也可能是字符串
                const asinsField = item.asins || (item.asin ? [item.asin] : []);
                const parentAsin = item.parent_asins?.[0]?.parent_asin;
                if (parentAsin) {
                  // asins 可能是数组，也可能是个对象
                  if (Array.isArray(asinsField)) {
                    for (const s of asinsField) {
                      const asin = (typeof s === 'string') ? s : (s?.asin || s?.value || '');
                      if (asin) parentMap[asin] = parentAsin;
                    }
                  } else if (typeof asinsField === 'string') {
                    parentMap[asinsField] = parentAsin;
                  }
                }
              }
              // 把父体 ASIN 注入到 listings
              for (const l of listings) {
                if (parentMap[l.asin]) {
                  l.parent_asin = parentMap[l.asin];
                }
              }
            }
          }
        } catch (pe) {
          // 父体查询失败不阻断主流程，记个日志
          console.log('[Listing] parent ASIN lookup failed:', pe.message);
        }

        return sendJSON(res, { listings, store_name: storeName });
      } catch (e) {
        return sendError(res, '查询Listing失败: ' + e.message, 500);
      }
    }

    if (parts[0] === 'listing' && parts[1] === 'query-products' && method === 'GET') {
      // 查询本地产品库（用于选择SKU）
      const sid = new URL(req.url, 'http://localhost').searchParams.get('sid');
      const search = new URL(req.url, 'http://localhost').searchParams.get('search') || '';
      if (!sid) return sendError(res, '缺少 sid');

      try {
        // 先获取店铺对应的 listing 列表
        const listingResult = await callLingXingApi('/erp/sc/data/mws/listing', 'POST', {
          sid: String(sid),
          is_pair: 1,
          is_delete: 0,
          offset: 0,
          length: 200
        });

        if (listingResult.code !== 0) {
          return sendJSON(res, { products: [] });
        }

        let listings = listingResult.data || [];
        
        // 搜索过滤
        if (search) {
          const s = search.toLowerCase();
          listings = listings.filter(item => 
            (item.seller_sku || '').toLowerCase().includes(s) ||
            (item.asin || '').toLowerCase().includes(s) ||
            (item.item_name || '').toLowerCase().includes(s) ||
            (item.local_sku || '').toLowerCase().includes(s)
          );
        }

        const products = listings.map(item => ({
          seller_sku: item.seller_sku,
          asin: item.asin,
          local_sku: item.local_sku,
          item_name: item.item_name,
          status: item.status === 1 ? '在售' : '停售',
          marketplace: item.marketplace
        }));

        return sendJSON(res, { products, total: listingResult.total });
      } catch (e) {
        return sendError(res, '查询产品失败: ' + e.message, 500);
      }
    }

    if (parts[0] === 'listing' && parts[1] === 'preview' && method === 'POST') {
      // 预览变更差异（不做实际提交）
      const body = await readBody();
      const { store_id, seller_sku, title, bullet_points, product_description, backend_search_terms, main_image_url, other_image_urls } = body;
      if (!store_id || !seller_sku) return sendError(res, '缺少 store_id 或 seller_sku');

      try {
        // 先查询当前内容
        const curResult = await callLingXingApi('/listing/publish/openapi/amazon/product/search', 'POST', {
          store_id: Number(store_id),
          skus: [seller_sku]
        });

        const currentAttrs = curResult.data?.[0]?.info?.attributes || {};
        const currentSummary = curResult.data?.[0]?.info?.summaries?.[0] || {};

        const curTitleEntry = (currentAttrs.item_name || []).find(a => a.language_tag === 'en_US');
        const curBullets = (currentAttrs.bullet_point || []).filter(a => a.language_tag === 'en_US').map(a => a.value);
        const curDesc = (currentAttrs.product_description || []).find(a => a.language_tag === 'en_US');
        const curKeywords = (currentAttrs.generic_keyword || []).filter(a => a.language_tag === 'en_US').map(a => a.value);

        // 当前副图
        const curOtherImages = [];
        for (let i = 1; i <= 7; i++) {
          const img = (currentAttrs[`other_product_image_locator_${i}`] || [])[0];
          curOtherImages.push(img?.media_location || '');
        }

        const diff = {
          seller_sku,
          asin: currentSummary.asin || '',
          title: { old: curTitleEntry?.value || '', new: title || '' },
          bullet_points: { old: curBullets, new: bullet_points || [] },
          product_description: { old: curDesc?.value || '', new: product_description || '' },
          backend_search_terms: { old: curKeywords, new: backend_search_terms || [] },
          main_image: { old: (currentAttrs.main_product_image_locator?.[0]?.media_location || ''), new: main_image_url || '' },
          other_images: { old: curOtherImages, new: other_image_urls || [] }
        };

        return sendJSON(res, diff);
      } catch (e) {
        return sendError(res, '预览失败: ' + e.message, 500);
      }
    }

    if (parts[0] === 'listing' && parts[1] === 'save' && method === 'POST') {
      const body = await readBody();
      const { store_id, seller_sku, product_type, marketplace_id, title, bullet_points, product_description, backend_search_terms, main_image_url, other_image_urls } = body;
      
      if (!store_id || !seller_sku) return sendError(res, '缺少 store_id 或 seller_sku');

      try {
        // 组装 attributes
        const attrs = {};

        if (title) {
          attrs.item_name = [{ value: title, language_tag: 'en_US', marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }];
        }

        if (bullet_points && bullet_points.length > 0) {
          attrs.bullet_point = bullet_points.map(v => ({ value: v, language_tag: 'en_US', marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }));
        }

        if (product_description) {
          attrs.product_description = [{ value: product_description, language_tag: 'en_US', marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }];
        }

        if (backend_search_terms && backend_search_terms.length > 0) {
          attrs.generic_keyword = backend_search_terms.map(v => ({ value: v, language_tag: 'en_US', marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }));
        }

        if (main_image_url) {
          attrs.main_product_image_locator = [{ media_location: main_image_url, marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }];
        }

        // 处理副图（1-7）
        if (other_image_urls && Array.isArray(other_image_urls)) {
          for (let i = 1; i <= 7; i++) {
            const url = other_image_urls[i - 1];
            if (url) {
              attrs[`other_product_image_locator_${i}`] = [{ media_location: url, marketplace_id: marketplace_id || 'ATVPDKIKX0DER' }];
            } else {
              attrs[`other_product_image_locator_${i}`] = [];
            }
          }
        } else if (main_image_url) {
          // 只更新主图时不清副图
        }

        // 查询当前 listing 获取 productType（如果未提供）
        let finalProductType = product_type;
        if (!finalProductType) {
          try {
            const curResult = await callLingXingApi('/listing/publish/openapi/amazon/product/search', 'POST', {
              store_id: Number(store_id),
              skus: [seller_sku]
            });
            const summary = curResult.data?.[0]?.info?.summaries?.[0];
            finalProductType = summary?.productType;
            if (!marketplace_id) {
              // 从返回数据获取 marketplace_id
            }
          } catch (e) {
            // 查询失败继续
          }
        }

        if (!finalProductType) {
          return sendError(res, '无法确定 productType，请提供 product_type 参数', 400);
        }

        // 提交到领星
        const result = await callLingXingApi('/listing/publish/openapi/amazon/product/publish', 'POST', {
          store_id: Number(store_id),
          data: [{
            sku: seller_sku,
            productType: finalProductType,
            operationType: 1,
            attributes: attrs
          }]
        });

        if (result.code !== 1) {
          return sendError(res, result.msg || '提交失败', 500);
        }

        return sendJSON(res, { success: true, data: result.data, request_id: result.request_id });
      } catch (e) {
        return sendError(res, '提交失败: ' + e.message, 500);
      }
    }

    return sendError(res, '未知API', 404);
  } catch (e) {
    console.error('API错误:', e.message);
    return sendError(res, e.message, 500);
  }
}

// ─── 启动前配置 ────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const NO_AUTH_PATHS = ['/api/auth/login', '/api/auth/verify'];

// ============================================================
// 启动服务器
// ============================================================

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  // API 路由
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    const parts = pathname.replace('/api/', '').split('/').filter(Boolean);
    // 认证检查（login/verify 除外）
    if (!NO_AUTH_PATHS.includes(pathname)) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const user = verifyToken(token);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: '未登录或登录已过期', need_login: true }));
      }
      req.authUser = user.username;
    }
    return handleAPI(req, res, parts);
  }

  // 静态文件
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // 安全检查
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============================================================
// 启动时日志轮转（防止日志无限增长）
// ============================================================
const LOG_FILE = path.join(__dirname, 'server.log');
try {
  const stat = fs.statSync(LOG_FILE);
  if (stat.size > 5 * 1024 * 1024) {  // 超过5MB自动轮转
    fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    console.log('[Log] 日志已轮转 (旧日志 > server.log.old)');
  }
} catch(e) { /* 没有日志文件，忽略 */ }

// ============================================================
// 平稳重启信号处理（SIGTERM 优雅退出）
// ============================================================
process.on('SIGTERM', () => {
  console.log('[Graceful] 收到 SIGTERM，正在关闭服务...');
  server.close(() => {
    console.log('[Graceful] 服务已关闭');
    process.exit(0);
  });
  // 强制退出超时兜底
  setTimeout(() => process.exit(0), 5000);
});

// ─── EADDRINUSE 兼容处理 ────────────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ads-web] 端口 ${PORT} 已被占用，3秒后重试`);
    setTimeout(() => { server.close(); process.exit(0); }, 3000);
    return;
  }
  console.error('[ads-web] 启动错误:', err.message);
});

// ─── 异步启动 ────────────────────────────────────────────
async function main() {
  try {
    console.log('[Ads-Web] 正在初始化数据库...');
    await db.initDatabase();
    DB_READY = true;
    // 从DB加载配置
    loadConfigFromDB();
    console.log('[Ads-Web] 数据库就绪，已加载配置');
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ 广告关键词管理 Web UI 已启动`);
      console.log(`   http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('[Ads-Web] 启动失败:', e.message);
    process.exit(1);
  }
}

main();



