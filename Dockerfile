FROM node:alpine as base

FROM base as builder1
RUN apk --no-cache add make python curl-dev g++
RUN mkdir /app
WORKDIR /app
RUN BUILD_ONLY=true npm install nodegit
#RUN apk --no-cache -q add build-base libgit2-dev
#RUN ln -s /usr/lib/libcurl.so.4 /usr/lib/libcurl-gnutls.so.4

FROM builder1 as builder
WORKDIR /app
COPY package.json /app/
COPY package-lock.json /app/
RUN npm install --only=prod

FROM builder1
COPY --from=builder /app /app
COPY bin/ /app/bin/
# You can mount your real `/app/editable` volume when running docker
RUN mkdir -p /app/editable/
COPY views/ /app/views/
COPY public/ /app/public/
WORKDIR /app
EXPOSE 80
ENV NODE_PATH=/app/node_modules
ENV NODE_ENV=production
ENV DIR=/app/editable/
ENV PATH="${PATH}:/app/node_modules/.bin"
CMD ["node", "bin/server.js"]
