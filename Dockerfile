# 单鱼版镜像：零依赖，所以不用 npm install
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs setup.mjs ./
COPY lib ./lib
COPY vendor ./vendor
COPY public ./public

# 数据目录给非 root 用户
RUN mkdir -p /app/data && chown -R node:node /app && chmod 700 /app/data

USER node

ENV HOST=0.0.0.0 \
    PORT=8790 \
    SPONSOR_DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
