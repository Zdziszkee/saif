#!/usr/bin/env bash
# Enforce the merge gate on master/main:
#   - pull requests only (direct pushes blocked for everyone, including admins)
#   - PRs cannot be merged while the CI checks "unit-tests" / "verify" are failing
#
# Requires the GitHub CLI (`brew install gh`) authenticated as a user with
# admin access to the repository:
#
#   gh auth login
#   ./scripts/setup-branch-protection.sh
#
# Uses a repository ruleset (bypass disabled) so the rules cannot be silently
# ignored by admins. Re-run any time to update the rules in place.

set -euo pipefail

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
RULESET_NAME="protect-master-main"

echo "Applying ruleset '${RULESET_NAME}' to ${REPO} ..."

gh api --method POST "repos/${REPO}/rulesets" --input - <<'JSON'
{
  "name": "protect-master-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/master", "refs/heads/main", "~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "unit-tests" },
          { "context": "verify" }
        ]
      }
    }
  ],
  "bypass_actors": []
}
JSON

echo "Done. Direct pushes to master/main are now rejected, and PRs can only be"
echo "merged when the 'unit-tests' and 'verify' checks pass."
