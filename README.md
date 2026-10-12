# Postmaxxers V2 — Cloud Login Test

This is an independent experimental Cloudflare Worker. It will not touch the original extension, Worker, or GitHub repository.

## Phase 1
Test whether Cloudflare Browser Run can access the members leaderboard using forum session cookies stored securely as a Worker secret. This is read-only and does not publish results.

## Setup
1. Install Node.js locally and run `npm install`.
2. Run `npx wrangler login`.
3. Add Worker secrets using `npx wrangler secret put FORUM_COOKIE` and `npx wrangler secret put ADMIN_TOKEN`. Set `FORUM_COOKIE` to the semicolon-separated forum cookie name/value pairs, entered only in Cloudflare (never GitHub or chat). Do not include cookies for unrelated sites.
4. Deploy using `npm run deploy`.
5. Check `https://YOUR-WORKER.workers.dev/health`.
6. Test `POST /probe` with `Authorization: Bearer YOUR_ADMIN_TOKEN`.

Do not commit credentials, tokens or cookies. The generic login implementation is best-effort; a successful personal browser login does not guarantee server-side browser access. Respect the forum's rules and rate limits.

This is not production-ready and does not yet include scheduled scans, a database, Force Scan, or live browser updates.

## Session security
Session cookies act like a password. Do not share or commit them. A login cookie can expire or be invalidated, and may be rejected when used from another IP or device. The probe does not attempt to bypass verification challenges. Revoke the session in the forum if exposed.
