/**
 * 广告关键词AI管理系统 - 主服务
 *
 * 完整复刻 openclaw ads-web-backend 所有功能 + SQLite持久化 + Docker化
 * 数据来源：领星ERP API（广告数据）+ 卖家精灵（市场数据）
 *
 * 端口默认 18444，可通过环境变量 PORT 修改
 * 配置通过 /api/settings 管理，持久化到 SQLite
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

// ─── 数据库 ───
const db = require('./db.cjs');

// ─── 路径 ───
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── MIME ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ─── 不认证的路径 ───
const NO_AUTH_PATHS = [
  '/api/auth/login',
  '/api/auth/verify',
  '/api/settings/public',
  '/api/health',
];

// ─── ─── ─── ─── ─── ─── ───
//  工具函数
// ─── ─── ─── ─── ─── ─── ───

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('JSON parse error: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, message, status = 400) {
  sendJSON(res, { error: message }, status);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ─── ─── ─── ─── ─── ─── ───
//  认证系统
// ─── ─── ─── ─── ─── ─── ───

function getAuthSecret() {
  return db.get('auth_secret') || 'default-secret-change-me';
}

function generateToken(username) {
  const secret = getAuthSecret();
  const payload = { username, exp: Math.floor(Date.now() / 1000) + 86400 }; // 24h
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const secret = getAuthSecret();
    const sig = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (sig !== parts[2]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { username: payload.username };
  } catch (e) {
    return null;
  }
}

// ─── ─── ─── ─── ─── ─── ───
//  领星ERP API 调用
// ─── ─── ─── ─── ─── ─── ───

let _lingxingToken = null;
let _lingxingTokenExp = 0;

async function getLingXingToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_lingxingToken && _lingxingTokenExp > now + 300) return _lingxingToken;
  const appId = db.get('lingxing_app_id');
  const appSecret = db.get('lingxing_app_secret');
  if (!appId || !appSecret) throw new Error('领星ERP未配置App ID或Secret，请先到设置页面配置');
  try {
    const result = await rawHttpRequest('/auth/openapi/access', 'POST', {}, {
      app_id: appId,
      app_secret: appSecret,
    });
    if (result.code === 0 && result.data?.access_token) {
      _lingxingToken = result.data.access_token;
      _lingxingTokenExp = now + (result.data.expires_in || 7200) - 300;
      return _lingxingToken;
    }
    // 兼容其他返回格式
    if (result.access_token) {
      _lingxingToken = result.access_token;
      _lingxingTokenExp = now + (result.expires_in || 7200) - 300;
      return _lingxingToken;
    }
    throw new Error('获取领星token失败: ' + JSON.stringify(result));
  } catch (e) {
    throw new Error('领星认证失败: ' + e.message);
  }
}

async function callLingXingApi(apiPath, method = 'GET', body = null) {
  const token = await getLingXingToken();
  const headers = { 'Authorization': 'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json';
  return rawHttpRequest(apiPath, method, headers, body);
}

async function rawHttpRequest(apiPath, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'openapi.lingxing.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'AdsKeywordPlatform/1.0',
        ...headers,
      },
      timeout: 30000,
    };
    if (postData) {
      opts.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); }
        catch (e) { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── ─── ─── ─── ─── ─── ───
//  卖家精灵 MCP API 调用
// ─── ─── ─── ─── ─── ─── ───

async function callSellerspriteTool(operation, params) {
  const secret = db.get('sellersprite_secret');
  if (!secret || secret === 'deleted') {
    throw new Error('卖家精灵密钥未配置，请先到设置页面配置');
  }
  const response = await fetch('https://mcp.sellersprite.com/v1/tool/' + operation, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'AdsKeywordPlatform/1.0',
      'secret': secret,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('卖家精灵API ' + operation + ' 失败: ' + response.status + ' ' + text);
  }
  return response.json();
}

// ─── ─── ─── ─── ─── ─── ───
//  企微 Webhook 推送
// ─── ─── ─── ─── ─── ─── ───

async function pushToWecom({ title, content, msgtype = 'markdown' }) {
  const webhookUrl = db.get('wecom_webhook_url');
  if (!webhookUrl) return { skipped: true, reason: 'Webhook URL not configured' };

  const logId = db.addPushLog({ type: 'webhook', title, content, status: 'sending' });

  try {
    const payload = { msgtype };
    if (msgtype === 'markdown') {
      payload.markdown = { content: content.length > 4000 ? content.slice(0, 4000) + '\n... (截断)' : content };
    } else if (msgtype === 'text') {
      payload.text = { content: content.length > 2000 ? content.slice(0, 2000) + '\n...(截断)' : content };
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();

    if (result.errcode === 0) {
      db.updatePushLog(logId, { status: 'success' });
      return { success: true };
    } else {
      db.updatePushLog(logId, { status: 'failed', error: result.errmsg || 'unknown' });
      return { success: false, error: result.errmsg };
    }
  } catch (e) {
    db.updatePushLog(logId, { status: 'failed', error: e.message });
    return { success: false, error: e.message };
  }
}

// ─── ─── ─── ─── ─── ─── ───
//  分析引擎（导入）
// ─── ─── ─── ─── ─── ─── ───

let analyzeKeyword = null;
try {
  analyzeKeyword = require('./analysis-engine.cjs').analyze;
} catch (e) {
  console.error('[WARN] analysis-engine.cjs 未加载:', e.message);
  analyzeKeyword = function() {
    return { analysis: [], suggestions: ['分析引擎未加载'], summary: '引擎不可用', score: 0, scoreLabel: '不可用' };
  };
}
