FROM node:20-alpine

WORKDIR /app

# 复制依赖配置
COPY package.json ./

# 安装依赖（sql.js 是纯JS，无需编译工具）
RUN npm install --production

# 复制源代码
COPY src/ ./src/
COPY docker/entrypoint.sh /entrypoint.sh

# 数据持久化目录
VOLUME ["/app/data", "/app/cache"]

ENV DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 18444

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:18445/api/auth/verify || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.cjs"]
