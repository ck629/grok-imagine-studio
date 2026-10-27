FROM node:22-alpine

WORKDIR /app

# 零 npm 依赖, 无需 npm install
COPY package.json server.js ./
COPY public ./public

# 容器内需监听 0.0.0.0 才能映射端口
ENV HOST=0.0.0.0 PORT=3210

EXPOSE 3210

CMD ["node", "server.js"]
