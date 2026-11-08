# folzy-music

Endpoint для блока «Сейчас играет» и статистики музыки на folzy.ru. Работает как Cloudflare Worker:
бесплатно, по HTTPS, секреты лежат в Cloudflare и в браузер не попадают.

- **Сейчас играет** — тот же трек, что selfbot ставит в пост канала. Бот сам шлёт его сюда (`site_push.py`)
  при смене трека, при перемотке и раз в минуту пульсом. Хранится в Durable Object `NOW`: читается сразу,
  без задержки. Пульса нет 3 минуты (бот лежит) — трек берётся из Last.fm (`wxnna_cry`).
- **Статистика** — из Last.fm: туда скробблит Dotify.

| Путь        | Что                                                                                    | Кэш    |
|-------------|----------------------------------------------------------------------------------------|--------|
| `GET /`     | `{ now, stats }`                                                                       | 5 с    |
| `GET /now`  | `playing`, `track` (+ `duration`, `position` на `server_time`), `last`, `source`       | 5 с    |
| `GET /stats`| `today`, `week`, `month`, `avg_day` (треки и секунды), `top`, `estimated`              | 10 мин |
| `POST /now` | от selfbot, `Authorization: Bearer PUSH_TOKEN`                                         | —      |

Сутки, неделя (с понедельника) и месяц считаются по `TIMEZONE` (Рига).
Время прослушивания — сумма длительностей треков. Длительности приходят из `track.getInfo` и копятся в KV;
пока известны не все, остаток считается по медиане, и в ответе `estimated: true` (на сайте стоит «≈»).

## Запуск

Из папки `worker`:

```bash
npx wrangler login
npx wrangler kv namespace create CACHE      # выданный id вписать в wrangler.toml
npx wrangler secret put LASTFM_API_KEY      # тот же ключ, что у selfbot, или новый: last.fm/api/account/create
npx wrangler secret put PUSH_TOKEN          # любая длинная случайная строка
npx wrangler deploy
```

После деплоя:
1. Адрес воркера вписать в `assets/js/config.js` сайта (`musicEndpoint`).
2. В `.env` контейнера selfbot добавить `SITE_NOW_URL=<адрес воркера>/now` и `SITE_PUSH_TOKEN=<тот же PUSH_TOKEN>`,
   перезапустить бота.

Тесты: `npm test`.
