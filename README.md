# 广告关键词AI管理系统 (Ads Keyword AI Platform)

基于领星ERP API + 卖家精灵数据的广告关键词管理面板，支持 **SP/SB/SBV** 三类广告活动的关键词查询、竞价调整、状态管理和 AI 分析。

## 一键部署

```bash
git clone https://github.com/jijiangang/ads-keyword-platform.git
cd ads-keyword-platform
docker compose -f docker/docker-compose.yml up -d
```

## 访问

- **管理页面**: `http://<服务器IP>:18444`
- **默认登录**: `admin / admin123`（首次登录后建议修改密码）

## 首次配置

登录后 → 点击右上角 ⚙️ 设置 → 填写：
1. **领星ERP** App ID / App Secret
2. **卖家精灵** Secret Key
3. 可选：设置**企微Webhook URL**接收推送通知

## 版本

| 版本 | 日期 | 说明 |
|:----:|:----:|:-----|
| v1.0.0 | 2026-07-26 | 首个Docker版本，完整复刻openclaw版功能 |

## 架构

```
┌─ 浏览器 ──────────────┐
│  http://host:18444     │
└──────────┬────────────┘
           │
┌──────────▼────────────┐
│  Docker容器 (端口18444) │
│  ┌──────────────────┐ │
│  │  server.js       │ │  ← Node.js 后端（HTTP API + 静态文件）
│  │  analysis-engine │ │  ← AI 关键词分析引擎（8维联合判断矩阵）
│  │                  │ │
│  │  SQLite (data/)  │ │  ← 系统配置 / 推送日志 / 修改记录
│  │  cache (data/)   │ │  ← 卖家精灵查询缓存
│  └──────────────────┘ │
└────────────────────────┘

数据流:
  [浏览器] ⇄ HTTP API ⇄ [server.js]
                              ⇄ 领星ERP API（Amazon广告数据）
                              ⇄ 卖家精灵 MCP（市场数据）
                              ⇄ SQLite（配置/日志持久化）
                              ⇄ 企微Webhook（推送通知）
```

## 功能清单

- ✅ 店铺/广告组合/广告活动三级数据导航
- ✅ SP（关键词 + ASIN定位）数据查询 + 操作
- ✅ SB/HSA 关键词 + 商品投放数据查询
- ✅ SBV 分投 ASIN 性能报告
- ✅ 卖家精灵市场数据（搜索量/竞争/CPC/趋势）
- ✅ 批量关键词竞价调整 / 暂停 / 启用
- ✅ 单关键词 AI 分析（8维矩阵评分）
- ✅ 批量 AI 分析（并发3路）
- ✅ 卖家精灵缓存（24h TTL，自动过期）
- ✅ 修改记录持久化
- ✅ 系统设置页面（领星/卖家精灵/密码/Webhook全可配）
- ✅ 企微Webhook推送（关键词异常/日报等）
- ✅ OOM 自动保护 / SIGTERM 优雅关闭 / 日志轮转
- ✅ Docker 一键部署（含数据持久化）

## License

MIT
