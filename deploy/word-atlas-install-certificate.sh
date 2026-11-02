#!/usr/bin/env bash
set -euo pipefail
# The root-owned helper serializes imports, honors manual mode, validates and probes.
/opt/nodejs/node-v24.22.1-linux-x64/bin/node --input-type=module -e '
import {helperRequest} from "/usr/local/lib/word-atlas-admin/server/operations.mjs";
try { await helperRequest("auto-install"); console.log("Certificate renewal hook completed (manual mode is preserved)."); }
catch { console.error("Certificate renewal application failed; previous certificate retained."); process.exitCode=1; }
'
