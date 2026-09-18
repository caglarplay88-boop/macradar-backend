const url = process.env.API_BASE || 'https://macradar-backend.onrender.com/health';

(async () => {
  const r = await fetch(url);
  const t = await r.text();
  console.log(r.status, t);
  if (!r.ok) process.exit(1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
