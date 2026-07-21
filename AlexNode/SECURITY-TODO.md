# Security TODO

## 🔴 Rotate the Neon database credential (HIGH PRIORITY)

**What happened:** The `.env` file — containing the real Neon Postgres password — was committed to git
before it was added to `.gitignore`. It has since been untracked (`git rm --cached .env`), but it
**still exists in the git history** of past commits. Untracking does not remove it from history.

**Exposed credential:** `DATABASE_URL` for the Neon project (user `neondb_owner`, host
`ep-autumn-art-atil9wtk...us-east-1.aws.neon.tech`).

**What to do:**
1. Log into the Neon dashboard → your project → **Roles / Reset password** for `neondb_owner`
   (or create a new role and retire the old one).
2. Update the local `.env` with the new `DATABASE_URL`.
3. Confirm the app still connects: `npm run dev` (should log "Connected to Postgres via Prisma").

**Optional — scrub it from git history:**
Rotating the password makes the leaked one useless, which is the important part. If you also want the
old secret gone from history entirely (e.g. before pushing to a public remote), we can rewrite history
with `git filter-repo` — ask Claude to do this. Note: it rewrites commit hashes.

---
_Left by Claude during Phase 0 housekeeping. Delete this file once the credential is rotated._
