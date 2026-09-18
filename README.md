# MacRadar Backend

Bu proje, Termux'ta çalışan BetExplorer sisteminin buluta taşınmış sürümüdür. Mevcut çalışan mantık korunur:

- BetExplorer günlük futbol bülteni
- seçilen maçları takibe alma
- MS 1-X-2, 1.5 Alt/Üst, 2.5 Alt/Üst, KG Var/Yok oranlarını çekme
- ilk 3 bookmaker verisini kaydetme
- oran snapshot geçmişi
- her saat seçili maçların otomatik güncellenmesi için `worker.js`
- Termux SQLite geçmişini `seed-data.json` ile ilk açılışta PostgreSQL'e aktarma

## Render

Web service:
- Build: `npm install`
- Start: `npm start`
- Env: `DATABASE_URL`, `API_KEY`

Cron job:
- Schedule: `0 * * * *`
- Build: `npm install`
- Start: `npm run worker`
- Env: aynı `DATABASE_URL`

## API

- `GET /health`
- `GET /api/bulletin?date=YYYY-MM-DD`
- `GET /api/matches`
- `GET /api/matches/:eventId`
- `POST /api/follow` body: `{ "urls": ["..."] }`
- `POST /api/matches/:eventId/refresh`
- `DELETE /api/matches/:eventId`
- `POST /api/matches/:eventId/resume`

Yazma işlemlerinde `X-API-Key` header'ı kullanılır.
