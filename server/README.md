# Free account backend

Implements `docs/superpowers/specs/2026-10-29-free-email-accounts-design.md`.
All enabled accounts can sync and back up for free. Legacy membership columns
are preserved, but never authorize or deny access. The compatibility response is
`membership:{active:!disabled,permanent:true,expiresAt:null}`.

Requires Node 24 and the parent's pinned Nodemailer 10.3.0 installation. This
module does not bind ports, configure secrets, install dependencies or deploy.

## Integration

```js
import { createAccounts } from "./server/accounts.mjs";
import { createMailerFromEnv } from "./server/mailer.mjs";
const mailer = createMailerFromEnv(process.env);
const accounts = createAccounts({
  dbPath: process.env.ACCOUNTS_DB,
  origins: ["https://your-canonical-host"],
  initializeDatabase: false,
  ...(mailer.enabled
    ? {
        sendEmailCode: mailer.sendCode,
        emailCodeSecret: process.env.MAIL_CODE_SECRET,
      }
    : {}),
});
// Before serving static files:
if (await accounts.handle(req, res)) return;
// On shutdown: drain requests, then accounts.close(); mailer.close();
```

`createAccounts` synchronously opens/migrates the dedicated file-backed SQLite
database and returns `{handle,close,db}`. `handle` leaves non-API routes untouched.
The exposed database is for trusted local operations only. `close` is idempotent;
drain in-flight HTTP/password requests before closing SQLite. Email delivery is
background work: synchronous `accounts.close()` cancels its timers, revokes this
instance's pending codes and prevents any late settlement from accessing SQLite.
It does not wait for or falsely cancel underlying SMTP promises.

`createMailerFromEnv(env=process.env)` returns `{enabled,sendCode,sendTest,close}`.
Only complete configuration enables mail:

| Key                   | Required value                                              |
| --------------------- | ----------------------------------------------------------- |
| SMTP_HOST             | smtp.126.com                                                |
| SMTP_PORT             | 465                                                         |
| SMTP_SECURE           | 1 (also accepts true)                                       |
| SMTP_USER / SMTP_FROM | sz_allen@126.com                                            |
| SMTP_PASS             | Nonempty SMTP authorization credential                      |
| MAIL_CODE_SECRET      | 64 hexadecimal characters, generated randomly and persisted |

The parent manages `/etc/word-atlas/mail.env`, root ownership/mode 0600,
systemd loading and hidden TTY credential entry. Never copy credentials into
source, commands, chat or logs. Missing/invalid mail configuration disables mail;
username registration/login remain available. No default/test code exists.

Trusted local CLI callers may invoke `await mailer.sendTest()` once after owner
configuration. It sends the fixed subject `词与远方邮件服务接入测试` from/to
`sz_allen@126.com`, explicitly states it is not a login/registration code, and
contains no OTP. There is no HTTP route for this method. It shares the same
transport, safe errors, closed/disabled checks and four-send concurrency bound.

The mailer fixes the sender and TLS host/port, verifies certificates, requires
TLS 1.2+, disables protocol logging and file/URL access, and sets connection,
greeting and socket timeouts to 15 seconds. It validates a single ASCII recipient
and six-digit code before sending; transport failures become generic errors.

## HTTP contract

Every API response is JSON, `Cache-Control:no-store`, with nosniff and
`Vary: Cookie, Origin`. Errors are `{error,code}`; conflicts include `version`.
Rate limits return 429 with `Retry-After` seconds. Times are Unix milliseconds.

`GET /api/auth/session` returns `{user,csrfToken,enabled,emailEnabled}`. A user
contains `{id,username,nickname,email,emailVerified,role,disabled,membership}`.
Legacy username accounts have `email:null,emailVerified:false`. Email addresses
are lowercased, unique, at most 254 characters, and never automatically merged or
rewritten using provider-specific rules. Email-only accounts also store their
normalized email in the existing non-null username column. The `@` namespace
cannot collide with valid ASCII username registrations.

| Endpoint                             | Request                                                                                 | Success                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| POST /api/auth/register              | `{username,password,nickname?}` OR `{email,code,password,nickname?}`                    | `{user,csrfToken}`                                            |
| POST /api/auth/login                 | `{identifier,password}` OR legacy `{username,password}`; either identifier may be email | `{user,csrfToken}`                                            |
| POST /api/auth/email-code            | `{email,purpose:'register'\|'login'}`                                                   | `{ok:true,retryAfter:60,expiresIn:300}`                       |
| POST /api/auth/login-code            | `{email,code}`                                                                          | `{user,csrfToken}`                                            |
| POST /api/auth/logout                | `{}`                                                                                    | `{ok:true}`                                                   |
| POST /api/auth/password              | `{currentPassword,password}`                                                            | `{ok:true}`; all user credentials revoked                     |
| POST /api/auth/reauth                | `{password}`                                                                            | `{ok:true}`; authorization strictly less than five minutes    |
| POST /api/auth/reset                 | `{token,password}`                                                                      | `{ok:true}`; single-use credential, all user sessions revoked |
| GET /api/account/progress?dataset=ID | Required owner header                                                                   | `{version,snapshot}`                                          |
| PUT /api/account/progress?dataset=ID | `{version,snapshot}`                                                                    | `{version}`; atomic CAS                                       |
| GET /api/account/backups?dataset=ID  | Required owner header                                                                   | `{backups:[{id,createdAt,version}]}`                          |
| POST /api/account/backups?dataset=ID | `{snapshot}`                                                                            | `{id,createdAt,version}`                                      |
| GET /api/account/backups/:id         | Required owner header                                                                   | `{snapshot,version}`; wrong owner gets 404                    |
| GET /api/admin/users?q=TEXT          | Admin                                                                                   | `{users}`; maximum 200                                        |
| GET /api/admin/audit                 | Admin                                                                                   | `{audit}`; newest 200                                         |
| POST /api/admin/users/:id/status     | `{disabled:boolean}`; recent admin reauth                                               | `{user}`                                                      |
| POST /api/admin/users/:id/reset      | `{}`; recent admin reauth                                                               | `{token,expiresAt}`; 30 minutes                               |
| POST /api/admin/users/:id/membership | Legacy admin action; recent reauth                                                      | 410 membership_removed; no changes                            |

`/api/member/*` remains an alias of `/api/account/*` for existing clients; it has
exactly the same free-account authorization. Disabled accounts cannot access
either. Administrators cannot disable the last active administrator or reset
another administrator through HTTP; administrator recovery is local CLI only.
Search remains by username/nickname (email-only usernames contain their email).

Bootstrap reuses anonymous one-hour sessions; login and registration rotate
token and CSRF. Authenticated sessions last seven days, maximum ten/user and
10,000 globally. Cookie: `wa_session; Path=/; HttpOnly; Secure; SameSite=Lax`.
Only token SHA-256 digests are stored. Passwords use salted async scrypt with a
process-wide two-active/32-queued work bound; overload returns 503.

All writes require trusted Origin, JSON and `X-CSRF-Token`. Optional
`X-Account-ID` on writes must match the session; every cloud request requires it,
including reads. Identity and revocation are rechecked after streaming/password
work. Ownership always comes from the session, never a submitted user ID.
Transport checks trust the actual TLS socket/peer, not forwarded headers. Host
must match configured origins. Non-TLS bootstrap returns disabled capabilities;
other requests require HTTPS (426). Only explicit loopback development can opt
out using `allowInsecureLocal:true,secureCookies:false`.

## Email challenge guarantees

- Exactly six decimal digits including leading zeros, cryptographically random;
  valid for 300000 ms from creation, expired at the exact boundary.
- Purpose-isolated and single-use. Resend replaces the old challenge immediately.
  Delivery failures remove the new challenge rather than restoring an old code.
- SQLite table is named **email_codes**. It stores a nonce and HMAC-SHA256 over
  email, purpose, nonce and code using a separate persistent secret, never the
  plaintext code. Constant-time comparison; at most five valid-shape wrong guesses.
- Initial verification happens before expensive password hashing. A transaction
  rechecks the current nonce, expiry, attempts and account identity after hashing,
  then creates/logs in the account, consumes the challenge and rotates the session
  atomically. Concurrent replay cannot succeed twice.
- Pending deliveries are unusable. Each process admits at most four background
  jobs, with no queue. HTTP acceptance precedes eligibility checks and SMTP;
  unknown, disabled, eligible, busy and recipient-delivery-failure cases all
  return the same `{ok:true,retryAfter:60,expiresIn:300}`. This means "if eligible,
  attempt delivery", not a promise that an email was sent. Only globally missing
  mail configuration returns 503; validation, CSRF and durable limits still apply.
  Capacity drops are intentionally silent; retry after the advertised cooldown.
  Every accepted resend invalidates the previous challenge, including drops.
  A 15-second background watchdog removes pending codes on stalled delivery. A
  timed-out injected sender retains its slot until its promise settles, bounding
  even non-cooperative work. No late settlement can reactivate a removed,
  revoked, superseded or shutdown-cancelled challenge. SMTP failures never enter
  HTTP responses or logs. The trusted CLI `mailer.sendTest()` may still report
  generic delivery failure to its local operator; it is not an HTTP endpoint.
- Durable rate rows enforce a cross-purpose 60-second/email cooldown plus fixed
  windows of 5/email/hour, 20/actual-peer-IP/hour, and 200/global/hour. Unknown or
  ineligible emails consume those same budgets and receive the same success JSON
  without delivery. SMTP timing/results and admission are not exposed through
  recipient-dependent HTTP responses. This is not a constant-time cryptographic
  guarantee or a promise to hide ordinary network/database timing noise.
  Verification additionally has a 30/15-minute/IP admission bound.
- Password changes, completed password resets, admin reset issuance and disabling
  revoke related challenges, including pending deliveries. Local admin credential
  reset does the same. The parent's whole-store restore invalidation must delete
  `email_codes` along with sessions/reset tokens before serving the restored DB.
- Configuring an injected `sendEmailCode({email,purpose,code})` requires an
  independent persistent secret of at least 32 bytes; production uses random
  64-hex configuration. Changing that secret invalidates outstanding codes.

## Storage, migration and operations

v1→v2 uses a transactional additive migration, preserving user IDs, password
hashes, legacy columns, sessions, progress, backups, reset credentials and audit.
It adds nullable email, verification flag, unique email index and `email_codes`.
No table of existing user data is rebuilt. Initialization is explicit for normal
production opens; unknown versions, unversioned nonempty stores, corrupt schemas
and integrity failures fail startup. SQLite uses prepared statements, foreign
keys, WAL, FULL synchronous commits, disabled extensions and private 0600 files.

The parent must take a consistent SQLite online backup before migration or
deployment. Do not copy only an online DB while ignoring WAL. Restores require
stopping the service, preserving current DB/WAL/SHM, installing a consistent
private copy, revoking temporary credentials and verifying before reopening.
Migration preserves old sessions; whole-store restore intentionally revokes them.

Cloud protection is unchanged: CAS conflicts do not modify progress; maximum
three backups/dataset and 20 datasets/account; default 40 MiB/account and 512 MiB
global stored-snapshot quotas, counting replacements/retention. JSON bodies are
bounded at 10 MiB for cloud writes and 16 KiB for auth, four concurrent body
readers, 15-second body timeout, strict UTF-8/shape/depth/prototype validation and
no compression. Existing durable login/bootstrap/cloud/admin rate limits remain.
Online backup helpers retain seven complete private copies and ignore unrelated
files. No off-host redundancy is implied.

## Verification

Run `node --test server/*.test.mjs` from the feature workspace. All HTTP tests
use temporary file-backed SQLite databases, loopback servers, controlled time
and explicit insecure-local opt-in. Mail tests capture injected messages or stub
Nodemailer's transport; **no external email is sent**. RED receipts covered
missing free/email behavior, the absent mailer, and helper-compatible
`SMTP_SECURE=1`; GREEN runs verify the resulting implementations.

Coverage includes v1 migration preservation, exact OTP expiry, five attempts,
purpose separation, resend, durable cooldown/send budgets, async hashing expiry,
concurrent registration/login replay, pending sends and failure cleanup, challenge
revocation, mail configuration/TLS/header validation, free legacy-expiry behavior,
disabled users, HTTPS/Host/Origin/CSRF, IDOR, CAS, quota, session/password bounds,
backups, CLI and restore checks. Test names/output in the handoff are the receipt;
there are no skipped or disabled tests. Real SMTP delivery, production migration,
frontend integration and deployment are the parent's responsibility and are not
claimed by this backend test suite.
