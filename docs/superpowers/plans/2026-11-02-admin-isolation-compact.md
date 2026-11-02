# Admin Isolation and Compact Console Plan

User requests execution: admin login must land directly in the administration workspace with no learner scenes; stop collecting/displaying system service statuses; shorten helper copy and fit all admin panels to viewport without document scrollbars.

## Scope and decisions

- All authenticated `role=admin` identities render the independent console regardless of entry hash; canonical route `#/admin`. No learner shell, welcome flow, personal-center link or automatic study cloud synchronization. Preserve existing personal study data without deletion.
- Remove the service catalog menu and collection path entirely for now, including privileged RPC. Existing authorized `/api/admin/services` requests return an explicit disabled status without invoking collection; role checks remain. Keep project uptime/host resource overview and TLS subsystem operational.
- Compact headings/cards/spacing; remove repetitive assurances and hints while retaining errors, confirmation of dangerous actions, critical certificate validation metadata, accessible labels and password requirements.
- Paginate long lists and account tools using available viewport height; put password/audit and certificate tasks into compact selectable views/steps. No document horizontal/vertical overflow at tested desktop/phone sizes. Do not merely clip controls or apply blanket body overflow hiding.
- Preserve ordinary user/guest flows, idle policies, credentials, certificate and audit behavior.

## Tasks / evidence

- [x] RED tests for admin root/hash routing without learner data fetch or cloud sync; service API/RPC disabled without touching systemctl. Observed old root landing, cloud requests, API 200, helper acceptance and collector execution; all focused checks GREEN.
- [x] Implement root admin gate before atlas readiness, role-aware cloud configuration, remove unconditional atlas preload and unnecessary forced-light media load.
- [x] Scoped UI worker optimizes Admin.tsx/admin.css/tests only: no service tab or personal return, explicit logout; viewport-fit pages, pagination and compact forms, concise copy. Seven viewport sizes tested with populated lists and sensitive forms.
- [x] Backend tests 118/118; focused browser checks; real API/TLS admin E2E 5 checks; full frontend 120/120; desktop account E2E 11/11 and mobile account E2E 12/12. Initial full run exposed a test-only asynchronous pagination wait race (119/120); fixed the assertion to wait for the fetched rows, then the complete fresh run passed 120/120.
- [x] Independent review of isolation, disabled collectors and unclipped forms; both minor findings addressed with regression coverage (canonical hash variants and session-error retry). Protected scoped backup and consistent account/guest database copies at `/data/host-audit-20261101/admin-compact-c3Ujc5`; deployed app and privileged helper, restarted both successfully. Eighteen deployed files match the tested checkout. Live desktop/mobile login, anonymous admin API denial, disabled privileged service action, database integrity and enabled existing admin verified without accessing credentials. TLS material/fingerprint and automatic renewal mode unchanged; pure IP still 403 and domain HTTP redirects to HTTPS.

## Verification records

Local logs: `.local/admin-compact-{backend,e2e,mobile,desktop-account,live}.log` and `.local/admin-compact-unit-final.log`; exit files are all zero. Production deployment uses scoped atomic source/index replacement and preserves old immutable assets. No schema migration, credential reset, user-data deletion, unrelated service changes or Git push performed.
