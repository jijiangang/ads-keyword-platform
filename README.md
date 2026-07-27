# 广告关键词AI管理系统 (Ads Keyword AI Platform)

基于领星ERP API + 卖家精灵数据的广告关键词管理面板，支持 **SP/SB/SBV** 三类广告活动的关键词查询、竞价调整、状态管理和 AI 分析。

## 快速部署

### 前置条件

- Docker & Docker Compose v2+
- 目标服务器已开放端口 18444

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/jijiangang/ads-keyword-platform.git
cd ads-keyword-platform

# 2. 首次启动（自动构建镜像）
docker compose -f docker/docker-compose.yml up -d --build

# 3. 验证
curl http://localhost:18444/api/health
```

### 苹果 Docker (macOS) 建议方式

```bash
# 在 Docker 数据目录下先创建持久化数据文件夹
mkdir -p ~/Docker/ads-keyword-platform/data
mkdir -p ~/Docker/ads-keyword-platform/cache

# 启动（覆盖 volume 映射到宿主文件夹，方便直接管理数据文件）
docker compose -f docker/docker-compose.yml up -d --build
```

容器名 `ads-keyword-platform`，Docker volume 命名规则：
| Volume | 名称 | 路径 |
|:-------|:-----|:-----|
| 数据 | `ads-keyword-platform-data` | `/app/data`（SQLite + 日志） |
| 缓存 | `ads-keyword-platform-cache` | `/app/cache`（卖家精灵缓存） |

> 若使用苹果 Docker Desktop，可在 Dashboard 中看到 `ads-keyword-platform` 容器和 `ads-keyword-platform-data` / `ads-keyword-platform-cache` 卷。

### 首次配置

1. 访问 `http://localhost:18444`
2. 默认登录：**`admin` / `admin888`**（登录后建议修改密码）
3. 点击右侧 **⚙️ 设置**，依次配置：
   - **领星ERP** App ID / App Secret
   - **卖家精灵** Secret Key
   - **AI 大模型**（关键词分析引擎需配置 API Key）
   - **企微 Webhook URL**（可选，接收推送通知）
   - **系统设置**（端口、内存限制等）
4. 在设置页 **用户管理** 区块可添加/删除/管理其他用户

### 容器管理

```bash
# 查看运行状态
docker ps -a --filter name=ads-keyword-platform

# 查看日志
docker logs -f ads-keyword-platform

# 停止
docker compose -f docker/docker-compose.yml stop

# 重启
docker compose -f docker/docker-compose.yml restart

# 更新（拉取新版本后重建）
git pull
docker compose -f docker/docker-compose.yml up -d --build

# 清理旧镜像
docker image prune -f
```

## 架构

```
┌─ 浏览器 ──────────────────┐
│  http://host:18444          │
└──────────┬────────────────┘
           │
┌──────────▼──────────────────┐
│  Docker容器: ads-keyword-    │
│  platform (端口18444)        │
│  ┌──────────────────────┐  │
│  │  server.cjs          │  │  ← Node.js 后端（HTTP API + 静态文件）
│  │  analysis-engine.cjs │  │  ← 8维AI关键词分析引擎
│  │                      │  │
│  │  SQLite (data/)      │  │  ← 系统配置 / 用户 / 推送日志 / 修改记录
│  │  缓存 (cache/)       │  │  ← 卖家精灵查询缓存（24h TTL）
│  └──────────────────────┘  │
└────────────────────────────┘

数据流:
  [浏览器] ⇄ HTTP API ⇄ [server.cjs]
                              ⇄ 领星ERP API（Amazon 广告数据）— 实时
                              ⇄ 卖家精灵 MCP（市场数据）— 实时 + 24h缓存
                              ⇄ SQLite（配置/用户/日志持久化）
                              ⇄ 企微Webhook（推送通知）
```

## 数据架构

| 数据源 | 获取方式 | 说明 |
|:-------|:---------|:-----|
| **领星ERP**（广告数据） | 纯实时 API 拉取 | 每次查询直接从领星 OpenAPI 获取，不做预存 |
| **卖家精灵**（市场数据） | 实时拉取 + 24h 文件缓存 | 首次查询实时调用，缓存至 `cache/ss_cache.json`，24h 内重复查直接返回缓存 |
| **SQLite 数据库** | 仅存元数据 | `system_config`/`users`/`push_logs`/`modify_history`，不存业务查询数据 |
| **定时同步** | 不启用 | 广告竞价调整需要查看实时数据，架构保持简单 |

## 功能清单

- ✅ SP/SB/SBV 三级广告数据查询（店铺 → 广告组合 → 广告活动）
- ✅ SP 关键词 + ASIN 定位数据查询与操作
- ✅ SB 关键词 + 商品投放数据查询
- ✅ SBV 分投 ASIN 性能报告
- ✅ 卖家精灵市场数据融合（搜索量/竞争/CPC/供需比）
- ✅ 批量关键词竞价调整 / 暂停 / 启用
- ✅ 单关键词 AI 分析（8维矩阵，26个场景评分）
- ✅ 批量 AI 分析（并发 3 路）
- ✅ 卖家精灵缓存（24h TTL，自动过期 + 额度耗尽自动降级）
- ✅ 修改记录持久化
- ✅ 系统设置页面（领星/卖家精灵/大模型/Webhook/全部可配）
- ✅ 用户管理（多用户 + 角色权限）
- ✅ 大模型 API Key 配置（OpenAI / DeepSeek / 自定义端点）
- ✅ 企微Webhook推送
- ✅ OOM 自动保护 / SIGTERM 优雅关闭 / 日志轮转
- ✅ Docker 一键部署（命名规范 + 数据持久化 + 健康检查）

## 版本

| 版本 | 日期 | 说明 |
|:----:|:----:|:-----|
| v2.0.0 | 2026-07-27 | 设置页面 + 用户管理 + 大模型配置 + 全面优化 |

## License

MIT
