# Kuest Auth Worker

Single-page Kuest API credential generator built for Cloudflare Workers.

The UI is a React/Vite static asset bundle, and all `/api/*` requests are handled by a native Cloudflare Worker.

## Runtime

- UI: React + Vite + Tailwind CSS.
- Wallet: Reown AppKit + Wagmi.
- Server: Cloudflare Worker TypeScript.
- Database: PostgreSQL insert into `public.key_emails`.

## Environment Variables

Public fixed config lives in `wrangler.jsonc` under `vars`:
`KUEST_CHAIN_MODE`, `SITE_NAME`, `APP_URL`, `APP_ICON`, `CLOB_URL`,
`RELAYER_URL`, `CLOB_URL_AMOY`, `RELAYER_URL_AMOY`, `CLOB_URL_MAINNET`,
`RELAYER_URL_MAINNET`.

`/api/kuest/create-key`, `/api/kuest/list-keys`, and `/api/kuest/revoke-key`
return `400` for malformed requests rejected by Kuest, `401` for rejected
signatures or API credentials, `403` for denied access, and `429` for rate
limits. Failed upstream services, differing rejections, and partial key
creation return `502`. Key listing retains the existing behavior of returning
nonempty results from one service, but it does not treat an empty response
from one service as proof of no keys when the other service fails. Revocation
succeeds if either service confirms it. The JSON error shape remains
`{ "error": { "message": "..." } }`.
After a `401` while creating a key, sign again in the wallet; the signed
timestamp may have expired while awaiting approval. A failed key listing does
not discard the credentials held in the current UI session.

The Auth UI defaults to the configured `KUEST_CHAIN_MODE` and exposes Amoy/Mainnet
in Advanced options. Each network must point to its own CLOB and Relayer URLs;
credentials are derived independently from the wallet and chain ID.

For local development, copy `.dev.vars.example` to `.dev.vars`. For production, set the remaining values as Worker secrets/variables in Cloudflare.

Keep `.env.example` as a reminder of the non-public values required for redeploys.

| Variable                  | Description                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `REOWN_APPKIT_PROJECT_ID` | Reown / WalletConnect project id                                                                     |
| `POSTGRES_URL`            | PostgreSQL connection string used by the Worker; include SSL settings if your provider requires them |

## Development

```bash
npm install
npm run dev
```

`npm run dev` runs the Vite + Cloudflare Worker dev environment. The app fetches runtime config from `/api/config`, so `.dev.vars` must include `REOWN_APPKIT_PROJECT_ID`.

## Validation

```bash
npm run check
npm run build
npm test
```

## Deploy

```bash
npm run deploy
```

The build emits:

- `dist/client`: static UI assets.
- `dist/kuest_auth`: Worker bundle and generated Wrangler config.

## Database

Apply the SQL migrations in `db/migrations` to any PostgreSQL database before first deploy.

```bash
psql "$POSTGRES_URL" -f db/migrations/0001_key_emails.sql
```
