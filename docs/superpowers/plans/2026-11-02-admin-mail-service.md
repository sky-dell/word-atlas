# Admin Mail Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a responsive admin mail-service page that configures any TLS-capable SMTP provider, verifies it, saves it through a root-only helper, and reloads delivery without exposing the authorization code.

**Architecture:** A shared mail-config module validates generic SMTP input and resolves public endpoints. A mutable mail runtime owns the active sender and can verify candidate settings before switching. The authenticated admin API delegates persistence to the existing restricted root helper, while the React admin console adds a dedicated mail panel and password reauthentication flow.

**Tech Stack:** Node.js 24, ESM, Nodemailer, SQLite-backed admin audit/rate limits, React 19, TypeScript, Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-admin-mail-service-design.md`

## Global Constraints

- Support any SMTP provider that supports implicit TLS or STARTTLS with certificate validation and TLS 1.2 or newer.
- Never return, persist in SQLite, log, or audit the SMTP authorization code.
- Keep `/etc/word-atlas/mail.env` as a root-private regular file and preserve `MAIL_CODE_SECRET` across updates.
- Require admin role, CSRF, trusted Origin, recent password reauthentication, rate limiting, and audit for save and test.
- Reject localhost, loopback, private, link-local, multicast, and unspecified SMTP endpoints.
- UI copy contains only labels, values, state, validation errors, and button names; no explanatory paragraphs or feature hints.

## Review Focus

- DNS rebinding after validation: the tested behavior must pin the validated public address while preserving the provider hostname for TLS.
- Blank password during edits: the tested behavior must retain the current secret, while first-time configuration must reject a blank secret.
- Failed provider changes: the tested behavior must keep the previous active transport and file untouched.
- STARTTLS downgrade or invalid certificate: the tested behavior must fail verification without exposing transport diagnostics.
- Dynamic updates: overview and email-capability status must change immediately after a successful save without a process restart.

---

### Task 1: Generic SMTP Configuration and Endpoint Safety

**Files:**
- Create: `server/mail-config.mjs`
- Create: `server/mail-config.test.mjs`

**Interfaces:**
- Consumes: raw admin input and the current non-secret configuration.
- Produces:
  - `normalizeMailConfig(input, { currentPassword = '' }): MailConfigInput`
  - `resolvePublicSmtpTarget(host, { resolve = dns.promises.lookup }): Promise<{ address: string, family: 4 | 5 | 6, servername: string }>`
  - `mailerOptions(config, target): SMTPTransport.Options`
  - `mailConfigFromEnv(env): MailConfig | null`
  - `mailEnvFile(config, codeSecret): string`

- [ ] **Step 1: Write failing validation tests**

Add tests named `normalizes any TLS SMTP provider without exposing the password`, `rejects malformed provider fields and CRLF injection`, `requires a password for first configuration but preserves an existing password`, `rejects non-TLS modes and insecure field shapes`, and `serializes and re-parses generic SMTP environment configuration`.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test server/mail-config.test.mjs`

Expected: FAIL because `server/mail-config.mjs` does not exist.

- [ ] **Step 3: Implement the configuration module**

Implement strict host, port, security, username, from-address, display-name, password, and JSON-key validation. Normalize hostname casing and IDNA; cap all strings; reject control characters; require `tls` or `starttls`; emit only the fixed environment keys needed by Nodemailer and the owning systemd service.

- [ ] **Step 4: Add failing endpoint-resolution tests**

Add tests named `pins one validated public SMTP address`, `rejects loopback private link-local multicast and unspecified addresses`, and `uses the provider hostname as TLS server name`.

- [ ] **Step 5: Run the focused tests to verify RED**

Run: `node --test server/mail-config.test.mjs`

Expected: FAIL because `resolvePublicSmtpTarget` is undefined.

- [ ] **Step 6: Implement public endpoint resolution and transport options**

Resolve both address families, reject every non-public result, choose one validated address, return a matching family, and construct Nodemailer options with the IP as connection host, the original provider hostname as `tls.servername`, certificate verification enabled, minimum TLS 1.2, bounded timeouts, and no file/URL access.

- [ ] **Step 7: Run the focused tests to verify GREEN**

Run: `node --test server/mail-config.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/mail-config.mjs server/mail-config.test.mjs
git commit -m "feat: validate generic SMTP configuration"
```

### Task 2: Mutable Mail Runtime, Root Store, and Restricted Helper

**Files:**
- Modify: `server/mailer.mjs`
- Modify: `server/mailer.test.mjs`
- Create: `server/mail-store.mjs`
- Create: `server/mail-store.test.mjs`
- Modify: `server/admin-helper.mjs`
- Modify: `server/admin-helper.test.mjs`
- Modify: `server/operations.mjs`
- Modify: `scripts/configure-mail.mjs`
- Modify: `scripts/configure-mail.test.mjs`

**Interfaces:**
- Consumes: `normalizeMailConfig`, `resolvePublicSmtpTarget`, `mailerOptions`, and `mailEnvFile` from Task 1.
- Produces:
  - `createMailRuntime(initialConfig): { status(), verify(input), apply(input), sendCode(message), sendTest(), close() }`
  - `readMailStore(file): Promise<MailConfig | null>`
  - `writeMailStore(file, config): Promise<void>`
  - helper action `mail-save` with payload `MailConfig`.

- [ ] **Step 1: Write failing mail-runtime tests**

Add tests named `verifies a candidate provider without replacing the active provider`, `applies a verified provider and changes enabled status immediately`, and `keeps the active provider when verification or apply fails`.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test server/mailer.test.mjs`

Expected: FAIL because `createMailRuntime` is undefined.

- [ ] **Step 3: Implement the mutable mail runtime**

Retain the active transport and sanitized status, create a temporary transport for candidate verification, require STARTTLS when configured, close replaced transports only after a successful switch, and keep all send methods on a stable runtime object.

- [ ] **Step 4: Add failing root-store tests**

Add tests named `writes a root-private generic SMTP file atomically`, `preserves the existing mail-code secret`, `merges a blank password only when a stored provider exists`, and `rejects symlinks unsafe ownership and unsafe modes`.

- [ ] **Step 5: Run the focused test to verify RED**

Run: `node --test server/mail-store.test.mjs`

Expected: FAIL because the store module does not exist.

- [ ] **Step 6: Implement the root store and migrate the CLI**

Write through a same-directory `0600` temporary file with `fsync` and rename, validate the directory and existing file, preserve `MAIL_CODE_SECRET`, and update `scripts/configure-mail.mjs` to use the generic provider fields without accepting secrets through arguments.

- [ ] **Step 7: Add failing restricted-helper tests**

Extend the helper test to prove `mail-save` accepts only normalized SMTP fields, rejects all other actions and keys, writes through the injected store, and records success or failure without the password.

- [ ] **Step 8: Run helper and CLI tests to verify RED**

Run: `node --test server/admin-helper.test.mjs scripts/configure-mail.test.mjs`

Expected: FAIL because `mail-save` is rejected as an unsupported action.

- [ ] **Step 9: Implement helper and operations integration**

Add `mail-save` to the allowlist, inject the store into the helper, journal sanitized outcomes, and allow `createOperations().overview()` to read `mailEnabled` through a getter so status can change at runtime.

- [ ] **Step 10: Run focused tests to verify GREEN**

Run: `node --test server/mailer.test.mjs server/mail-store.test.mjs server/admin-helper.test.mjs scripts/configure-mail.test.mjs server/operations.test.mjs`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server scripts/configure-mail.mjs scripts/configure-mail.test.mjs
git commit -m "feat: add dynamic SMTP runtime and restricted storage"
```

### Task 3: Admin Mail API

**Files:**
- Modify: `server/accounts.mjs`
- Modify: `server/accounts.test.mjs`
- Modify: `scripts/server.mjs`

**Interfaces:**
- Consumes: the `createMailRuntime` object from Task 2 and `operations.request('mail-save', config, context)`.
- Produces:
  - `GET /api/admin/mail` returning `MailStatus`
  - `POST /api/admin/mail/test` returning `{ ok: true, elapsedMs: number, tlsProtocol: string }`
  - `POST /api/admin/mail` returning `MailStatus`

- [ ] **Step 1: Write failing API tests**

Add tests named `mail status is admin-only and never exposes the secret`, `mail test and save require CSRF and recent reauthentication`, `mail save delegates the complete normalized provider to the restricted helper and audits without the password`, and `mail test failure leaves status unchanged`.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test --test-name-pattern="mail" server/accounts.test.mjs`

Expected: FAIL because the mail routes return not found or unauthorized behavior does not match the contract.

- [ ] **Step 3: Implement routes and dynamic email capability**

Treat both POST routes as admin writes, read bodies within the auth limit, require trusted Origin/CSRF/recent owner reauthentication, rate limit, normalize the candidate, use the current in-memory secret when the form omits it, test without applying, save only after helper success, apply the runtime only after persistence success, and audit sanitized actions.

- [ ] **Step 4: Wire server startup**

Build the initial mail config from environment, create one runtime, pass its stable send function into accounts, pass an enabled getter into operations, and inject the root store into the existing restricted helper process.

- [ ] **Step 5: Run focused and server tests to verify GREEN**

Run: `node --test --test-name-pattern="mail" server/accounts.test.mjs server/mailer.test.mjs server/operations.test.mjs`

Run: `node --test server/*.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/accounts.mjs server/accounts.test.mjs scripts/server.mjs
git commit -m "feat: expose secure admin SMTP endpoints"
```

### Task 4: Admin Mail Service Page

**Files:**
- Modify: `src/pages/Admin.tsx`
- Modify: `src/styles/admin.css`
- Modify: `src/pages/admin-console.browser.test.ts`

**Interfaces:**
- Consumes: the three admin mail API routes from Task 3.
- Produces: `MailPanel` and a new `mail` admin section between `certificate` and `security`.

- [ ] **Step 1: Write the failing browser test**

Extend the admin fixture with mail status, reauthentication, test, and save routes. Assert that the left navigation exposes `邮件服务`, the current provider summary uses only non-secret data, the form exposes all required fields, testing and saving call reauthentication first, a blank authorization code is allowed after configuration, and first-time blank authorization code is rejected.

- [ ] **Step 2: Run the browser test to verify RED**

Run: `node --import tsx --test src/pages/admin-console.browser.test.ts`

Expected: FAIL because no `邮件服务` navigation button or panel exists.

- [ ] **Step 3: Add responsive-layout and copy assertions**

Include `邮件服务` in every desktop/mobile fit loop. Assert there is no paragraph-level instructional copy, no horizontal overflow at 320, 390, 768, 1280, and 1440 widths, no clipped controls, and stable card height when status or validation messages change.

- [ ] **Step 4: Run the browser test to verify RED for layout coverage**

Run: `node --import tsx --test src/pages/admin-console.browser.test.ts`

Expected: FAIL at the missing mail panel before layout checks can pass.

- [ ] **Step 5: Implement the panel and navigation**

Add the mail icon and section, a compact status card, and one configuration card using existing admin fields and buttons. Use a reusable inline password confirmation for both actions, clear the authorization-code input after requests, show only concise validation/error/status text, and reload sanitized status after save.

- [ ] **Step 6: Add scoped responsive styles**

Use the existing cream/navy tokens, 8px-or-less card radius rules already present, two-column form rows on wide screens, one-column on narrow screens, fixed control heights, and no nested cards.

- [ ] **Step 7: Run browser tests to verify GREEN**

Run: `node --import tsx --test src/pages/admin-console.browser.test.ts`

Expected: PASS with no page errors or control overlap.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Admin.tsx src/styles/admin.css src/pages/admin-console.browser.test.ts
git commit -m "feat: add admin SMTP configuration panel"
```

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `docs/ACCOUNTS-OPERATIONS.md`
- Modify: `server/README.md`
- Modify: `docs/superpowers/specs/2026-11-02-admin-mail-service-design.md`

**Interfaces:**
- Consumes: completed implementation from Tasks 1-4.
- Produces: operator documentation and verified delivery.

- [ ] **Step 1: Update operational documentation**

Document the generic SMTP fields, required TLS, provider-change workflow, root-owned file, password-never-returned rule, helper dependency, and fallback CLI. Remove statements that restrict the service to 126.

- [ ] **Step 2: Record implementation decisions in the spec**

Append the final endpoint names and runtime status behavior only if they differ from the approved design.

- [ ] **Step 3: Run formatting and static checks**

Run: `git diff --check`

Run: `npm run build`

Expected: both commands succeed.

- [ ] **Step 4: Run all tests**

Run: `node --test server/*.test.mjs`

Run: `npm test`

Expected: all tests pass; only pre-existing local-media skips remain.

- [ ] **Step 5: Perform browser verification**

Start the app against an isolated database and verify desktop and mobile screenshots for navigation, configured state, validation failure, reauthentication, successful connection, and successful save.

- [ ] **Step 6: Commit documentation and final verification**

```bash
git add docs/ACCOUNTS-OPERATIONS.md server/README.md docs/superpowers/specs/2026-11-02-admin-mail-service-design.md
git commit -m "docs: document generic SMTP administration"
```
