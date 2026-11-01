// Compatibility command: account authentication is now an independent page.
// A TEST_URL always selects read-only production smoke checks.
if(process.env.TEST_URL) await import('./entry-public-smoke.mjs');
else await import('./free-account-e2e.mjs');
