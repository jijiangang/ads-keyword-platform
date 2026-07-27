#!/usr/bin/env node
// sql.js 版持久化模块（纯JS，无需编译）
// 替代原 better-sqlite3 版本，API 100% 兼容

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'ads-platform.db');

let db = null;
let SQL = null;

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 保存到磁盘（sql.js需要手动持久化）
function persistDb() {
  try {
    if (db) {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    }
  } catch(e) {
    console.error('[DB] 持久化失败:', e.message);
  }
}

// 每60秒自动持久化
setInterval(persistDb, 60000);

// ==================== 初始化 ====================
async function initDatabase() {
  SQL = await initSqlJs();
  
  // 如果已有数据库文件，加载它
  let loadBuffer = null;
  if (fs.existsSync(DB_PATH)) {
    loadBuffer = fs.readFileSync(DB_PATH);
  }
  
  db = new SQL.Database(loadBuffer);
  
  // 启用WAL模式
  db.run('PRAGMA journal_mode=WAL');
  
  // 创建表结构
  db.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS push_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS modify_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      keyword_id TEXT,
      keyword_text TEXT,
      campaign_id TEXT,
      action TEXT NOT NULL,
      before_value TEXT,
      after_value TEXT,
      operator TEXT,
      remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS ss_cache (
      keyword TEXT PRIMARY KEY,
      response TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 用户表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      nick_name TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 如果users表为空，创建默认管理员
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM users');
  stmt.step();
  const countResult = stmt.getAsObject();
  stmt.free();
  if (countResult.cnt === 0 || countResult.cnt === '0') {
    db.run('INSERT INTO users (username, password, role, nick_name) VALUES (?, ?, ?, ?)',
      ['admin', 'admin888', 'admin', '管理员']);
    console.log('[DB] 默认管理员已创建 (admin/admin888)');
  }
  
  // 持久化
  persistDb();
  return db;
}

// ==================== API 方法 ====================

// 配置操作
function getConfig(key) {
  const stmt = db.prepare('SELECT value FROM system_config WHERE key = ?');
  const row = stmt.getAsObject([key]);
  stmt.free();
  return row.value || undefined;
}

function setConfig(key, value) {
  db.run(
    `INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
  persistDb();
}

function getAllConfig() {
  const stmt = db.prepare('SELECT key, value, updated_at FROM system_config ORDER BY key');
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function deleteConfig(key) {
  db.run('DELETE FROM system_config WHERE key = ?', [key]);
  persistDb();
}

// 推送日志
function createPushLog({ type, target, title, content, message, status }) {
  db.run(
    'INSERT INTO push_logs (type, title, content, status) VALUES (?, ?, ?, ?)',
    [type || 'wecom_webhook', title || target || '', (content || message || '').slice(0, 500), status || 'pending']
  );
  persistDb();
  // sql.js 不支持 lastInsertRowid 的直接方式，手动获取
  const stmt = db.prepare('SELECT MAX(id) as id FROM push_logs');
  const row = stmt.getAsObject();
  stmt.free();
  return row.id || 0;
}

function updatePushLog(id, { status, error }) {
  const updates = [];
  const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (error !== undefined) { updates.push('error = ?'); params.push(error); }
  if (updates.length === 0) return;
  params.push(id);
  db.run(`UPDATE push_logs SET ${updates.join(', ')} WHERE id = ?`, params);
  persistDb();
}

function getPushLogs(limit = 50) {
  const stmt = db.prepare('SELECT * FROM push_logs ORDER BY id DESC LIMIT ?');
  const results = [];
  stmt.bind([limit]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function cleanPushLogs(beforeDays = 30) {
  db.run("DELETE FROM push_logs WHERE created_at < datetime('now', '-' || ? || ' days')", [beforeDays]);
  persistDb();
}

// 修改历史
function createModifyHistory({ type, keyword_id, keyword_text, campaign_id, action, before_value, after_value, operator, remark }) {
  db.run(
    'INSERT INTO modify_history (type, keyword_id, keyword_text, campaign_id, action, before_value, after_value, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [type || '', keyword_id || '', keyword_text || '', campaign_id || '', action, before_value || '', after_value || '', operator || '', remark || '']
  );
  persistDb();
}

function getModifyHistory(campaignId, limit = 50) {
  let sql, params;
  if (campaignId) {
    sql = 'SELECT * FROM modify_history WHERE campaign_id = ? ORDER BY id DESC LIMIT ?';
    params = [String(campaignId), limit];
  } else {
    sql = 'SELECT * FROM modify_history ORDER BY id DESC LIMIT ?';
    params = [limit];
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// 卖家精灵缓存
function getSSCache(keyword) {
  const stmt = db.prepare("SELECT response FROM ss_cache WHERE keyword = ? AND created_at > datetime('now', '-1 day')");
  const row = stmt.getAsObject([keyword]);
  stmt.free();
  return row.response || null;
}

function setSSCache(keyword, response) {
  db.run(
    "INSERT INTO ss_cache (keyword, response, created_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(keyword) DO UPDATE SET response = excluded.response, created_at = CURRENT_TIMESTAMP",
    [keyword, typeof response === 'string' ? response : JSON.stringify(response)]
  );
  persistDb();
}

function cleanSSCache() {
  db.run("DELETE FROM ss_cache WHERE created_at < datetime('now', '-1 day')");
  persistDb();
}

// ==================== 用户管理 ====================

function getUsers() {
  const stmt = db.prepare('SELECT id, username, role, nick_name, is_active, created_at FROM users ORDER BY id');
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  stmt.bind([username]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function createUser({ username, password, role, nick_name }) {
  try {
    db.run('INSERT INTO users (username, password, role, nick_name) VALUES (?, ?, ?, ?)',
      [username, password, role || 'user', nick_name || username]);
    persistDb();
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function updateUser(id, { password, role, nick_name, is_active }) {
  try {
    const updates = [];
    const params = [];
    if (password !== undefined) { updates.push('password = ?'); params.push(password); }
    if (role !== undefined) { updates.push('role = ?'); params.push(role); }
    if (nick_name !== undefined) { updates.push('nick_name = ?'); params.push(nick_name); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active); }
    if (updates.length === 0) return { success: true };
    params.push(id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    persistDb();
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function deleteUser(id) {
  db.run('DELETE FROM users WHERE id = ? AND role != ?', [id, 'admin']);
  persistDb();
}

// ==================== 导出 ====================
module.exports = {
  initDatabase,
  getConfig,
  setConfig,
  getAllConfig,
  deleteConfig,
  createPushLog,
  updatePushLog,
  getPushLogs,
  cleanPushLogs,
  createModifyHistory,
  getModifyHistory,
  getSSCache,
  setSSCache,
  cleanSSCache,
  getUsers,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
};
