# Idle Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce 120-minute account and 240-minute guest inactivity logout without deleting study data.
**Architecture:** Persist server idle deadlines independently of absolute/retention deadlines. A shared browser interaction watcher sends bounded CSRF-protected activity calls; passive polling only checks deadlines.
**Tech Stack:** Node SQLite, React, TypeScript, Playwright.
**Spec:** `docs/superpowers/specs/2026-11-02-idle-session-design.md`.

## Global Constraints

- Account: 120 minutes; guest: 240 minutes. Polling and synchronization do not renew login.
- Existing account 7-day cap and guest 24-hour/7-day retention remain.
- Domain-only HTTPS and all stored learning records remain intact.
- Preserve the existing dirty development clone; no broad git staging, reset or push.

## Review Focus

- Exact deadline and failed authorization cannot renew a session.
- Sleeping/background pages must recheck before resuming private use.
- Activity in another tab must prevent a false local timeout.
- Guest re-entry must recover the same retained identity, not delete it.
- Existing database migration and old clients must fail safely.

### Task 1: Backend deadline contracts

Files: `server/database.mjs`, `server/accounts.mjs`, `server/guests.mjs`; associated backend tests.
Interfaces: session responses expose `idleExpiresAt` and `serverNow`; POST `/api/auth/activity` and `/api/guest/activity` accept `{}` with existing CSRF/identity checks. Guest session adds `loginRequired` on idle expiry; explicit POST session resumes retained guests.
- [x] Add literal-boundary tests for polling, authorized renewal, rejected renewal after expiry, restart, retained data and CSRF.
- [x] Run new tests RED, implement additive migration/deadlines, run all backend tests GREEN (78/78).

### Task 2: Browser enforcement

Files: new `src/session/activity.ts`, `src/session/activity.test.ts`, account/guest state and App integration.
Interfaces: a watcher subscribes trusted interactions and checks a session via injected get/renew/check/expire callbacks; real integration uses existing account and guest clients.
- [x] Write watcher tests for passive time, active renewal, hidden tabs, stale async identity and cross-tab renewal; observe RED.
- [x] Implement bounded activity calls, deadline checking and return-to-entry without deleting records; run tests GREEN.

### Task 3: Integration and release

Files: new `scripts/idle-session-e2e.mjs`, documentation and test logs.
- [x] Use isolated SQLite/HTTP fixtures and controlled clocks for actual account and guest UI expiry/re-entry (4/4).
- [x] Build, run full frontend/backend suites, inspect scoped changes independently (118 frontend / 78 backend).
- [x] Back up code/databases; deploy additive changes atomically, preserve assets and data; validate live domain, guest entry, IP rejection and service health.
- [x] Record test evidence and deployment outcome; do not commit unrelated dirty files.

## Release evidence

Deployed with account schema v3 and independent guest idle column; both production databases passed quick-check and foreign-key checks. `word-atlas.service` is active. Live browser smoke passed 7 checks and disposable guest API smoke passed 3 checks. Live test guests were deleted only through their own credentials. No real email codes were sent, no production clock changed, and no learning database was cleared.

Protected backup: `/data/host-audit-20261101/idle-session-ytmqLu`. Logs/results: project `.local/idle-*`. Existing sessions beyond the newly configured idle windows may need one fresh login after release.
