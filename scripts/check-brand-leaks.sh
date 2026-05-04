#!/usr/bin/env bash
# Fails if hardcoded brand strings leak into UI / components / helpdocs.
#
# Run locally before committing brand-facing changes, and in CI on every push.
# If you add a legitimate internal reference (e.g. an HTTP header contract),
# extend the ALLOW_PATHS regex rather than weakening the PATTERN.

set -e
cd "$(dirname "$0")/.."

# Literal brand tokens that should come from lib/brand (TS/TSX) or be tokenized
# as {{brand.*}} (markdown) instead of being hardcoded. Word boundaries
# prevent false positives on internal compound identifiers like
# TwinPilotProjects / TwinPilotBucket (storage path naming, by design).
PATTERN='\bTirsa Factory\b|\bTirsa Software\b|\bTwinPilot\b|\bTwin Pilot\b|\btirsa-factory-cli\b|\btwin-pilot-cli\b|/tirsa-logo|/twinpilot-logo'

# Paths where brand literals ARE expected:
#   lib/brand* → brand module + generated active config
#   branding/ → vendored packs and config JSONs
#   app/api/  → server routes with Phase 4 migration done; remaining hits
#               are internal docstrings and HTTP contracts (X-Tirsa-*)
#   app/globals.css → internal CSS file-header comment
ALLOW_PATHS='lib/brand|branding/|app/api/|app/globals\.css'

SCAN_PATHS=(app components content/helpdocs)

hits=$(grep -rnE "$PATTERN" "${SCAN_PATHS[@]}" 2>/dev/null | grep -Ev "$ALLOW_PATHS" || true)

if [ -n "$hits" ]; then
  echo "::error::Brand leak detected — hardcoded brand strings in UI / docs:"
  echo "$hits"
  echo
  echo "Fix by importing the brand module:"
  echo '    import { brand } from "@/lib/brand";'
  echo "and referencing brand.name / brand.shortName / brand.cli.packageName / etc."
  echo
  echo "For markdown in content/helpdocs/, use the token form:"
  echo '    {{brand.name}}, {{brand.cli.packageName}}, ...'
  exit 1
fi

echo "✓ brand guardrail: no hardcoded strings"

# Invariant: lib/brand.active.ts must be committed with BRAND_ID=twinpilot
# defaults. TwinPilot is the official product; per-brand deploys regenerate
# this file in CI (sync-vercel.yml matrix). Committing a different flip
# would leak into TwinPilot's Vercel build before the matrix job runs.
if ! grep -q '"id": "twinpilot"' lib/brand.active.ts 2>/dev/null; then
  echo "::error::lib/brand.active.ts is not the twinpilot default."
  echo
  echo "The source repo commits brand.active.ts with BRAND_ID=twinpilot. You"
  echo "probably flipped BRAND_ID locally to validate another brand — regenerate:"
  echo
  echo "    cd services/command-center"
  echo "    npm run brand:prepare     # without BRAND_ID, uses twinpilot default"
  echo
  echo "Then commit again. Per-brand builds happen in CI, not from committed state."
  exit 1
fi

echo "✓ brand guardrail: brand.active.ts is twinpilot default"
