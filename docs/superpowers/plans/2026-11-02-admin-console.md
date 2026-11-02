# Administration Console Implementation Plan

> **For agentic workers:** use scoped parallel implementers for disjoint UI/certificate modules and main-agent integration; TDD and final independent review required.

**Goal:** Ship an admin-only sidebar console with runtime/service visibility, current activity, login history and safe TLS import/application.
**Architecture:** Reuse existing account/admin/CSRF/5-minute reauthentication. Main application reads bounded metrics and history. A root-owned Unix-socket helper with a fixed command set alone changes TLS versions; the web process gets no general root or service-control rights.
**Tech Stack:** React, Node 24, SQLite, systemd, OpenSSL, native TLS, Playwright.
**Spec:** User approved integrated console + restricted component, all project and host services read-only; admin chooses password interactively. Preserve idle policies (account 120m, guest 240m), domain-only HTTPS and all study data.

## Review Focus

Unknown/non-admin/expired/disabled sessions must never see operational data or upload private keys. Validate the chain, domain, private-key pair and dates before staging, with bounded memory/disk use. Hot application must verify actual served fingerprint and roll back on failure. Manual certificate mode must not be overwritten by automatic renewal. Guest presence stays temporary; no permanent guest login history. No credential/session hashes or raw key material in API output or logs.

## Interfaces

Admin GET endpoints: `/api/admin/overview`, `/services`, `/online`, `/logins?q=&page=`, `/certificate` (all under `/api/admin`). Existing `/users`, `/audit` unchanged.

Overview: `{project:{uptimeSeconds,startedAt},host:{uptimeSeconds,load,cpus,memory:{total,free,used},disk:{total,free,used}},checks:[{name,status,detail}]}`.
Services: `{services:[{name,description,loadState,activeState,subState,unitFileState,category}],sampledAt}`; category `project|system`.
Online: `{users:[{id,username,nickname,kind,role,sessionCount,loggedInAt,lastActivityAt,idleExpiresAt,active}],sampledAt,activeWindowSeconds:300}`. Active = recent trusted interaction, not polling.
Logins: `{events:[{id,username,method,result,createdAt}],page,pages,total}`. Formal users only, bounded 90-day/10,000-row history; no retrospective invention.
Certificate metadata: `{subject,issuer,domain,validFrom,validTo,fingerprint256,daysRemaining,serialNumber}`. GET certificate: `{mode,current,previous}`. POST `/api/admin/certificate/stage` accepts `{certificatePem,privateKeyPem}` -> `{stageId,certificate,expiresAt}`. POST `/apply` `{stageId}`, `/rollback` `{}`, `/automatic` `{}` -> `{ok,certificate}`. All require fresh admin password verification, and inputs never become audit payloads.
Helper exports `createCertificateManager({domain,tlsDir,stateDir,initialCertificatePath,initialKeyPath,automaticCertificatePath,automaticKeyPath,trustStore,reload,probe,now})` with `status()`, `stage({certificatePem,privateKeyPem})`, `apply({stageId})`, `rollback()`, `automatic()`, `autoInstall()`. Staging root-only; applied version root:word-atlas 0640, atomic current symlink; opaque 32-hex stage ID, 15m expiry, bounded staging. `probe` must validate real served fingerprint; reload only the fixed word-atlas unit.
Unix RPC request `{action,payload}` with action whitelist `services|certificate|stage|apply|rollback|automatic|auto-install`. Application adapter exports `request(action,payload)`; socket group word-atlas, never public TCP.

## Tasks

- [x] Backend TDD: additive login/activity schema; success/failure/logout/timeout events and bounded history, formal/guest online aggregation, admin-only operational routes and sensitive reauth. Metrics from OS, existing readiness and fixed helper.
- [x] TLS TDD: real CA-signed fixture certificates, invalid/expired/wrong-domain/mismatched-key rejection; atomic switch, probe failure rollback, previous version, manual/automatic collision, serial execution and expired-stage checks. No real certificate replacement during tests.
- [x] UI TDD: responsive sidebar, overview cards, services filters, named online users, searchable paginated logins, retained account tools, safe file inputs/clear-after-upload/reauth/apply/rollback. Existing light visual system, mobile drawer/overflow-safe tables.
- [x] Integration: hardened helper unit + fixed RPC server; read-only systemd service catalog, server hot TLS reload, renewal hook honoring manual mode; local interactive admin initialization helper with no default password or promotion of a registered user.
- [x] Verify build, all frontend/backend tests, isolated admin E2E (permissions, activity/history, services and certificate flow), independent review; back up production code/DB/TLS/system units and deploy.
- [x] Check live HTTPS/domain-only, protected endpoints, helper permissions, no secret exposure, renewal compatibility. User confirmed administrator password was set through the interactive command; enabled `admin` role verified without reading its password.

## Release evidence

- Full frontend: 119/119; focused final mobile input/console check: 1/1; backend: 117/117 (29 certificate tests including real filesystem post-rename fsync fault).
- Isolated admin E2E: 4/4, actual Unix RPC and CA-trusted TLS apply/probe/rollback; mobile account E2E: 12/12; live domain browser smoke: 7/7.
- Production: schema v4, database integrity/foreign-key checks passed. Both app and restricted helper services active; app confirmed socket reachability within its service namespace. Helper sees 271 service/timer units.
- Live renewal hook hot-loaded the existing trusted certificate with unchanged application PID and fingerprint; IP HTTP/HTTPS remain blocked. Anonymous operational API reads return 401.
- Root module files match verified source; runtime socket root:word-atlas 0660 under 0750 directory, applied key root:word-atlas 0640, private state directory root-only 0700. Web user cannot read the independent journal.
- Independent review found two Important issues: uncertain final-state sync could misreport rollback; disconnected RPC could complete without audit. Both fixed RED→GREEN with verified rollback and root-owned durable operation admission/outcome journal. Startup pinning, canonical email failure search and generated guest display names also fixed.
- Backup: `/data/host-audit-20261101/admin-console-vemznT` (root-only, includes consistent pre-release databases and original TLS/system configuration). No unrelated worktree reset, Git push or user-data clearing.

RPC also exposes read-only `events`; mutation requests carry generated operation ID and actor ID metadata separate from certificate payloads. Independent audit never contains uploaded PEM or private-key bytes. Unfinished operations become `uncertain` after helper restart; HTTP client survival is not required to record outcome.
