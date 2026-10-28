# Уведомления о заходах в Telegram

1. @BotFather -> /newbot -> получить `BOT_TOKEN`. Написать боту любое сообщение.
2. Узнать свой `CHAT_ID` (@userinfobot или `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. Cloudflare Dashboard -> Workers & Pages -> Create -> Worker, вставить `worker.js`, Deploy.
4. Worker -> Settings -> Variables and Secrets -> добавить **Secret** `BOT_TOKEN` и `CHAT_ID`.
5. Адрес воркера (`https://folzy-visit-notify.<аккаунт>.workers.dev`) вписать в `WORKER_URL`
   в `index.html` обоих сайтов.

Через CLI: `npx wrangler deploy`, затем `npx wrangler secret put BOT_TOKEN` и `CHAT_ID`.
