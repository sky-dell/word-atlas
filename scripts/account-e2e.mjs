// Backward-compatible command for the current free-account integration suite.
// Obsolete membership grant/expiry UI cases were replaced by verified-email,
// free cloud ownership, non-modal dropdown and password/code-login cases.
import './free-account-e2e.mjs';
import { copyFile } from 'node:fs/promises';
await copyFile('.local/implementation/free-account-e2e.json','.local/implementation/account-e2e.json');
