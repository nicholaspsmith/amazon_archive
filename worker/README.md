# Sync Worker

Stores one JSON blob — the hidden-order set — in Cloudflare KV, behind a bearer
token. Free tier limits (100k KV reads/day, 1k writes/day, 100k requests/day)
are far beyond this extension's usage, and a Worker never pauses for inactivity.

## Deploy

```bash
cd worker
npx wrangler kv namespace create ORDERS      # copy the printed id into wrangler.toml
npx wrangler secret put AUTH_TOKEN           # paste a token; see below
npx wrangler deploy
```

Generate a token with:

```bash
openssl rand -base64 32
```

Keep that value. It goes into the extension's options page and nowhere else —
never into this repository.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sync` | Send local state, receive the merged union. Writes KV. |
| `GET` | `/list` | Read stored state. Does not write. |

Both require `Authorization: Bearer <token>`. Everything else returns 401.

## Smoke test after deploying

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://<your-worker>.workers.dev/list
# => {"version":1,"orders":{}}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"version":1,"orders":{"123-4567890-1234567":{"hidden":true,"ts":1}}}' \
  https://<your-worker>.workers.dev/sync
# => {"version":1,"orders":{"123-4567890-1234567":{"hidden":true,"ts":1}}}
```

The unrealistic `ts: 1` survives because pruning only expires tombstones
(`hidden: false`); a hidden entry is kept at any age. If you smoke-test an
unhide, use a real millisecond timestamp — `date +%s000` — or the tombstone will
be pruned on write and come back empty.
