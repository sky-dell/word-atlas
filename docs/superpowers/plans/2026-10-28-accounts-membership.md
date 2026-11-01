# Accounts and membership implementation plan

2026-10-29执行记录：Tasks 1–4已实现并完成独立后端复核、主代理前端复核与回归验证。前端76、后端/HTTP34、账号E2E11、原有E2E16通过；原有E2E也已在生产HTTPS通过。已发布HTTPS，校验证书、数据库、独立权限和旧入口，执行备份与证书续期演练成功。详细结果与已知边界见 `docs/ACCOUNTS-DATA-REVIEW.md`。没有创建生产默认管理员，所有者须在本机交互终端自行设置密码。下面保留原始实施检查清单作为历史计划，不以未勾选状态表示未实现。

> **For agentic workers:** Use executing-plans for integration, with bounded parallel backend and storage/UI implementers. User approved the design and implementation; proceed without another approval round.

**Goal:** Ship free registration, administrator-granted membership, isolated learning profiles and member cloud synchronization with safe HTTPS deployment.
**Architecture:** Existing Node24 HTTP server gains a same-origin account API backed by SQLite. React adds account/admin screens and scoped browser persistence; server-issued sessions, backend authorization and CAS enforce identity and data ownership.
**Tech Stack:** Node24, node:sqlite (release candidate, pinned), crypto.scrypt, React19/TypeScript, Playwright, Certbot IP certificates.
**Spec:** `/data/word-atlas/docs/superpowers/specs/2026-10-28-accounts-membership-design.md`, approved by user 2026-10-28.

## Constraints and rulings

- Preserve current anonymous learning, MIT attribution and existing local progress; never commit generated content/secrets or reset the dirty working tree.
- Build in `/data/word-atlas-accounts` from the current source snapshot; static media/dependencies are shared read-only, source files isolated. Production remains unchanged until verified integration.
- Use one backend worker and one profile/UI worker with disjoint file ownership. Parent integrates HTTP/TLS, API client/UI contracts, deployment and security review. Choose routine details autonomously under the approved design.
- No payments/outbound notifications. Secure cookies and no production password auth over HTTP. Data under `/var/lib/word-atlas`, strict permissions and bounded backups.
- No new remote git pushes/PR needed. Preserve earlier uncommitted work; record implementation and test receipts in this plan and a feature report.

## Review focus

1. Account switch while an old request is in flight must not put old data into the new account.
2. Stale service-worker cache must never serve account/admin responses.
3. Two-device first sync and later CAS conflicts must not silently overwrite local changes.
4. HTTP-to-HTTPS origin migration must retain access to old guest export.
5. Admin cancellation/disable/password reset must take effect for already logged-in clients.

## Task 1: backend account and membership API

Files: `server/accounts.mjs`, `server/accounts.test.mjs`, `scripts/admin.mjs`, `server/backup.mjs` and corresponding tests.
Interface: `createAccounts({dbPath, origins, secureCookies=true, allowInsecureLocal=false, now=Date.now})` returns `{handle(req,res):Promise<boolean>,close(),db}`. `handle` accepts `/api/*` only. API JSON errors `{error,code}`; user `{id,username,nickname,role,disabled,membership:{active,permanent,expiresAt}}`.

- [ ] Write and run RED real HTTP/database tests for register/login/session/logout, csrf/origin, password revocation, uniqueness, admin restrictions and membership live expiry.
- [ ] Implement `GET /api/auth/session` -> `{user:null|User,csrfToken,enabled}` with anonymous CSRF session supported; POST `/api/auth/register` `{username,password,nickname}`, `/login`, `/logout`, `/password` `{currentPassword,password}`, `/reauth` `{password}`, `/reset` `{token,password}`. JSON state-changing requests require `X-CSRF-Token` and Origin. Session cookie `wa_session` is HttpOnly/Secure/SameSite=Lax. Username grammar `[a-zA-Z0-9_]{3,32}`, password 12–128. Log no credentials.
- [ ] Admin APIs: GET `/api/admin/users?q=`, `/audit`; POST `/api/admin/users/:id/membership` `{days:30|90|365|permanent|cancel}` (permanent/cancel strings), `/status` `{disabled:boolean}`, `/reset` -> one-use `{token,expiresAt}`. All mutations require recent `/reauth`; no web role promotion.
- [ ] Cloud GET `/api/member/progress?dataset=ID` -> `{version,snapshot:null|Backup}` and PUT same URL `{version,snapshot}` require membership and `X-Account-ID` matching the current session; versions increment atomically, stale ->409 `{code:'conflict',version}`. Backup format existing `{app:'word-atlas',version:2,progress,settings,extras}`; reject invalid schema, 10MiB bound. Backup listing GET `/api/member/backups?dataset=ID` -> `{backups:[{id,createdAt,version}]}`, create POST same `{snapshot}`, download GET `/api/member/backups/:id` -> `{snapshot,version}` (own backup readable after expiry); retain3/dataset. Ownership from session, dataset bounded `[a-zA-Z0-9_-]{1,80}`. Optional account header asserted for all writes.
- [ ] Add reset-token expiry/single-use, bounded rate limiting, prepared SQL/WAL/version migration, offline CLI `create-admin`, `reset-admin`, `backup` with interactive passwords and no defaults. Async scrypt concurrency <=2.
- [ ] GREEN backend tests including file-backed restart, consistent DB backup/restore, invalid payload, IDOR, conflicts, expired/disabled sessions and admin authorization.

## Task 2: browser profile isolation and account UI

Files: `src/account/*`, profile helper in `src/store/profile.ts`, `src/store/store.ts`, reader/appearance/illustration consumers, `src/pages/Account.tsx`, `src/pages/Admin.tsx`, account CSS. Worker owns these, parent owns App/router/Me wiring only.
Interfaces: exported `AccountPanel` and `AdminPage`, `AccountController` mounts once. `useAccount()` -> stable state, bootstrap+CSRF client using backend contract. `switchProfile(userId|null):Promise<void>`, scoped key helpers for all local/IDB persisted learning data. `AccountController` bootstraps session before switching profile; guest key layout preserves old records.

- [ ] RED tests for guest/account namespace, A->B switch, stale writes/replies and local guest import opt-in, using existing test harness.
- [ ] Implement scoped persistence and all extras; wait for old flush before switch, scope generation check on replies, profile/identity notification across tabs. Anonymous guest keys remain legacy-compatible. On explicit guest import use sanitized existing export/import without deleting guest originals.
- [ ] Implement real registration/login/password/reset UI, member status/cloud autosync and explicit conflicts/resolution; capture and assert X-Account-ID, abort on identity change. Cloud snapshot excludes unfinished session. Saving/restoring backups, toasts, error/disabled/offline states and mobile layout.
- [ ] AdminPage consumes backend list/audit APIs and reauth before membership/status/reset actions; no passwords stored in localStorage; no frontend authority for membership.
- [ ] GREEN tests, `npm run build`; report exact edited paths and integration exports.

## Task 3: integration, service worker and HTTPS

Files: `scripts/server.mjs`, App/router/Me wiring, `public/sw.js`, relevant service tests, cert/deploy helpers and docs.

- [ ] RED tests for API bypass in SW, HTTP auth rejection and compatibility of static routes/ranges/legacy /words.
- [ ] Wire account handle before static lookup; enable DB via env; readonly static+write-only state dir. Route API only at canonical origin; 8080 static mirror has no functional accounts. Add `/api/` exclusion and purge API cache entries, honor no-store responses.
- [ ] Configure TLS on443 and HTTP80 entry plus guest-export migration page/route. ACME webroot handled safely outside dist so rebuild does not destroy challenges. Install current Certbot in isolated venv, request staging then trusted IP cert, deploy-hook copies keys into restricted state TLS dir and restart/reload. No public insecure auth fallback.
- [ ] Retain an HTTP learning/export path for origin migration rather than redirecting every old user before export. HTTPS official entry, clear migration action and manual backup import. If443 cloud blocked, verify locally and report precise outstanding cloud action; leave production auth disabled until safe.
- [ ] Validate cookie flags, host/origin/CSRF and TLS from actual endpoint, systemd permissions, DB persistence; run browser auth/admin/sync scenarios against separate test DB, never create public test users in production DB.

## Task 4: final verification and deployment

- [ ] Fresh review of new backend/profile/SW/deployment code against the approved spec; fix material issues with reproducing tests.
- [ ] Run all existing tests and backend tests, build and 16 original browser scenarios plus account/admin/CAS/mobile scenarios; check regression on legacy links/HTTP guest export.
- [ ] Snapshot source/deployment/config, preserve DB separately, publish only verified changes into `/data/word-atlas`, restart service, check HTTP/HTTPS and persistent state after restart.
- [ ] Install consistent local DB backup/limited retention and cert renewal timers. Do not populate a weak default administrator. Deliver interactive local admin creation command and feature/operations report, mark any cloud limitation accurately.
