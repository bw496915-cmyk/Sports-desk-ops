# SportsDesk Cloudflare API & R2 Storage Runbook

This guide details the integration of your Cloudflare Account, Scoped API Token, S3-Compatible Object Storage, and **Public R2 Access Subdomain (`r2.dev`)** with the **SportsDesk Operations Suite** (`sportsdesk_r2_sync.ts`, `sportsdesk_cli.ts`, `run_reports.sh`, and `deploy_to_vps.sh`).

## 1. Credentials & Configuration Matrix

| Variable | Configured Value | Operational Purpose |
| :--- | :--- | :--- |
| **`CLOUDFLARE_ACCOUNT_ID`** | `7a470541a704caaf91e71efccc78fd36` | Scopes Cloudflare API requests & R2 namespace |
| **`CLOUDFLARE_API_TOKEN`** | `<CLOUDFLARE_API_TOKEN>` *(configured in `.env`)* | Edge DNS, Tunnel authentication & API verification |
| **`R2_ACCESS_KEY_ID`** | `<R2_ACCESS_KEY_ID>` *(configured in `.env`)* | S3-compatible client access key |
| **`R2_SECRET_ACCESS_KEY`** | `<R2_SECRET_ACCESS_KEY>` *(configured in `.env`)* | S3-compatible secret signing key (SigV4) |
| **`R2_ENDPOINT`** | `https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com` | Global S3 REST endpoint |
| **`R2_BUCKET_NAME`** | `sportsdesk-ops-reports` | Dedicated bucket for report archives and audit bundles |
| **`R2_PUBLIC_URL`** | `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev` | Public HTTPS gateway for zero-egress report downloads |

## 2. Token Verification & Cloudflare Edge Services

### 2.1. Instant Verification via Curl

Run this command from your terminal or VPS to verify the token status:

```bash
curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/7a470541a704caaf91e71efccc78fd36/tokens/verify" \
  -H "Authorization: Bearer \${CLOUDFLARE_API_TOKEN}"
```

*Expected response:*
```json
{"result":{"id":"...","status":"active"},"success":true,"errors":[],"messages":[]}
```

## 3. Cloudflare R2 Object Storage Integration

### 3.1. Public R2 Direct Access Gateway (`r2.dev`)

Your bucket has public bucket access enabled via the `r2.dev` subdomain:
- **Base Public URL:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev`

Any file uploaded to the bucket is instantly accessible via direct HTTPS:
- **Report Bundle Manifest:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/MANIFEST.md`
- **Intra-Day Snipers (24h):** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/01_winners_24h.txt`
- **Monthly Leaderboard:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/05_monthly_leaderboard.txt`

### 3.2. Syncing Reports & Audits via CLI

Manage your cloud backups directly through `sportsdesk_cli.ts` or `sportsdesk_r2_sync.ts`:

```bash
# 1. Check configuration and credentials
bun run sportsdesk_cli.ts r2 --info

# 2. Verify token active status
bun run sportsdesk_cli.ts r2 --verify

# 3. Sync entire reports/ directory to R2 (prints direct public links)
bun run sportsdesk_cli.ts r2 --sync reports/
```

### 3.3. Automated Archiving in Reporting Pipeline (`run_reports.sh`)

Add `--sync-r2` to your daily or weekly report generation:

```bash
# Generates all 7 reports and uploads to R2 with direct public links
./run_reports.sh --format table --sync-r2
```
