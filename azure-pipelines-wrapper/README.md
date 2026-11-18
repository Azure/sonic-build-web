# event-collector

> A GitHub App built with [Probot](https://github.com/probot/probot) that Event Collector

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t event-collector .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> event-collector
```

## Qualified approval coverage

For the `sonic-net/sonic-mgmt` pilot, the bot posts informational PR
comments showing which changed folders have qualified approval, which are awaiting
approval, and which have no reviewer mapping. It does not block merging.

Reviewer assignment and qualified-approval processing apply only to PRs whose
**target (base) branch is `master`**. The source branch can have any name.
Other target branches are ignored before queueing and checked again when queued
work runs. Retargeting to `master` triggers normal base-branch-change processing.
Retargeting away stops further processing, including automatic merge-risk task
submission; existing comments, labels, and reviewer requests are left untouched.

Reviewer membership comes from
[`sonic-net/sonic-tsc` on `master`](https://github.com/sonic-net/sonic-tsc/blob/master/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml),
never from the PR branch. For each folder, add the mapped scores of distinct users
with active approvals for the current PR head. The folder qualifies only when
that sum is **at least 0.4**; exactly 0.4 qualifies. Multiple
approvers can combine their scores, but repeated reviews by the same user do not
add extra weight. Unmapped users contribute nothing. The comment shows the total
approval score for each folder. Scores are not pooled across different folders.
The most specific mapped folder wins,
with nearest-parent fallback only when there is no mapping for that folder. An
empty reviewer entry does not inherit its parent's reviewers.

Alternatively, a changed file qualifies when an active current-head approval is
from a matching `.github/CODEOWNERS` user or team member. Rules are case-sensitive,
the last matching rule wins, and an ownerless rule clears earlier owners.
CODEOWNERS approval does not need a score of 0.4. This is evaluated per file:
a folder is marked approved only when every changed path in it qualifies by
score or CODEOWNERS; renames still require both paths. The table lists approving
code owners, including team names when applicable.
The comment footer links both the reviewer mapping and the CODEOWNERS file used
for evaluation. If CODEOWNERS is missing, it says that the file is not available.

An active current-head approval from a **repository administrator** also
qualifies all changed paths, without a reviewer-mapping score or CODEOWNERS match.
The bot checks each active approver's repository permission using GitHub's
collaborator permission API; only `admin` qualifies through this override, not
`maintain`, `write`, or organization membership alone. The summary lists approving
administrators separately; their mapping score is not artificially increased.
The same exclusions apply: PR-author, bot, stale, dismissed, changes-requested,
and individually re-requested approvals do not qualify as administrator approvals.
Permission lookup failures propagate through the action queue rather than being
assumed to mean approval or non-admin status. Repository permission changes are
evaluated on the next processed PR event, not continuously polled.
Administrator approval also skips additional reviewer assignment for all paths.

The bot reads CODEOWNERS at the PR's trusted **base commit**, not its head.
A missing file (404) is allowed and leaves score-based behavior unchanged.
Other read failures and team membership failures are errors, not assumed approval.
Team resolution needs organization members read permission on the bot token.
Supported patterns include anchored paths, directories, `*`, `**`, and `?`.
Unsupported syntax (including email owners, negation, character classes, and
escaped paths) is reported explicitly rather than guessed.

Only each user's latest decisive review counts (`APPROVED`, `CHANGES_REQUESTED`,
or `DISMISSED`); a comment-only review does not replace an approval. Approvals
must match the current head commit. PR-author and bot approvals are excluded.
An outstanding individual review request also excludes that user's earlier
approval, including when a reviewer requests their own review again. GitHub can
keep the earlier review's REST state as `APPROVED` while re-review is pending.
Once the request clears, the latest decisive current-head review is eligible
again. Requests for other users do not invalidate an approver, and a team request
alone does not invalidate every team member's approval.
Different qualified users can cover different folders. Renamed files require
coverage of both old and new paths, but count only once in the overall file total.
The table shows up to 100 folders; totals always include all changed files.
Mapping/API failures and incomplete file lists are logged through the action queue
instead of producing a misleading coverage result.

The coverage summary is posted as a **new comment only when a new approval review is
submitted**. Comment-only reviews, changes requested, dismissals, PR lifecycle
events, and new commits do not publish or update comments. Consequently, the
summary is a snapshot as of the latest processed approval, not a continuously
refreshed status. Previous comments are never edited, and each processed approval
posts a new snapshot even if its coverage is identical to an earlier one.
Comments use the existing `mssonicbld` token.

When every changed path in every folder has qualified approval, the bot adds
`Qualified-approval`. The fresh coverage comment on a new approval announces that
all folders qualify and explains that this meets the qualified-approval requirement
for auto-merge. Partial coverage (including a rename with only one qualified path)
or an empty changed-file list does not qualify.

The label is kept current on PR lifecycle events listed below, base-branch changes,
submitted approvals or changes-requested reviews, and dismissed reviews. If coverage
is affected by a review request being added or removed, the bot recalculates
silently without assigning reviewers or posting a coverage comment. If coverage
is lost, the bot removes the label without posting another comment. Comment-only
reviews do not replace approvals or trigger recalculation. Existing matching labels
are not re-added. When qualification is lost, the bot also removes `automerge`
if its latest label addition was by `mssonicbld`. It paginates PR issue events
to verify the current addition's author; an older bot addition does not authorize
removing a label subsequently re-added by another user. Human-added labels and
labels with unconfirmed provenance are preserved, as are unrelated labels.
The same cleanup runs on `pull_request.unlabeled` events for `Qualified-approval`,
including manual removals, without recalculating coverage or re-adding the label.
It rechecks that qualification is still absent before removing `automerge`.
Later unqualified coverage updates retry cleanup if `automerge` remains.
Label and event-history API failures are reported
through the action queue. Reviewer assignment lookup failures do not prevent an
already-calculated label update.

The label certifies approval coverage, **not all merge conditions**: required CI,
branch protection, draft state, and mergeability still apply. The wrapper does not
enable GitHub auto-merge or merge PRs. Lifecycle/dismissal updates do not edit old
coverage comments; consult the current label for the latest evaluated status.
Mapping and CODEOWNERS changes outside these PR events are not polled.

Deployment: enable **Pull request review** webhook events in the existing GitHub
App settings (changing `app.yml` alone does not update an installed app). The bot
token needs read access to the trusted mapping repository and PR files/reviews,
and write access to PR issue comments and labels. Publish the reviewer mapping at the trusted
upstream path above before deployment; a local copy or a copy in a fork is not used.
The bot token also needs permission to read
collaborator permission levels for active approvers.
Additional repositories must be explicitly
added to the pilot allowlist after their mappings are available.

### Merge risk assessment

When a processed PR event finds full qualified-approval coverage, the bot submits
`POST /v1/task-plans/github-app` to
`https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net`.
The payload uses type `MERGE_RISK_ASSESSMENT`, the hardcoded PBI ID `"40516754"`,
and a description identifying the PR URL and head commit. Both the wrapper and
terminal smoke test omit `model`, which is not required by the GitHub-app endpoint.
The PBI must document the PR; this integration does not create or update PBIs.

Authentication requires `ADO_MI_CLIENT_ID`, the client ID of the user-assigned
managed identity attached to the wrapper's Azure host, with scope
`api://sonic-testbed-tools-prod/.default`. Grant that identity access to the
scheduler API. This reuses the Azure DevOps identity selection setting, but
requests a separate scheduler token; it does not reuse Key Vault or Azure DevOps
tokens. Missing or empty identity configuration fails explicitly when submitting;
there is no system-assigned identity or local-login fallback.

After a successful submission, the bot posts a receipt comment with a
`sonic-merge-risk-assessment` marker for that head commit and explicitly states
that submission is not completion or approval to merge. It paginates comments
and trusts only receipts authored by `mssonicbld`, using the existing bot token.
Receipts survive restarts and prevent repeat submissions for the same head,
including after approval is lost and regained. A newly qualified head gets a new
assessment. Lifecycle events can post this receipt even though they do not post
coverage summaries. The qualified label alone is not a submission receipt.

Authentication, HTTP, timeout, and receipt-write failures propagate to the action
queue logs. Non-2xx HTTP errors include up to 8192 bytes of the response body,
so scheduler validation failures (HTTP 422) identify rejected fields rather than
only showing the status code. Empty bodies and truncation are reported explicitly;
the access token is redacted if echoed by the server.
Requests time out after 60 seconds of socket inactivity and are not
automatically retried. A later qualifying event can retry when no receipt exists.
The API contract provides no idempotency key: if the scheduler accepts a request
but its response or the GitHub receipt is lost, a later event can submit a
duplicate. The existing queue serializes events in one wrapper process; multiple
wrapper instances would require scheduler-side idempotency or shared locking.
Do not delete receipt comments if deduplication is needed.

Submission does not change qualification, block merging, wait for the assessment
result, or enable auto-merge. The receipt confirms submission only.

#### Terminal API smoke test without Azure CLI

**From the development App Service:** deploy the script alongside the wrapper's
dependencies, then open SSH into the running application container. If the wrapper
is deployed directly under `/home/site/wwwroot`, run:

```sh
cd /home/site/wwwroot
node --version
node test_merge_risk_assessment.js --managed-identity --submit
```

If the repository layout is preserved, first change into the
`azure-pipelines-wrapper` subdirectory. This mode requires the same
`ADO_MI_CLIENT_ID` setting as the wrapper, with no browser sign-in or development
tenant/client variables. Configure that setting with the client ID of a
user-assigned identity attached to the development App Service (or the specific
deployment slot), and authorize it for the scheduler. Both submission paths use
PBI `40516754`.
The Kudu/SCM console can run in a separate container without the app's managed
identity endpoint; use the application container's SSH terminal when necessary.
The target remains the **production scheduler**, even from a development site.
The smoke test authenticates and submits directly; it does not validate webhook
delivery, approval coverage, or receipt deduplication.

**From a local development terminal:**
Use Node.js 18+ and the existing dependencies:

```sh
cd azure-pipelines-wrapper
node test_merge_risk_assessment.js --help

export ENTRA_TENANT_ID='<your-tenant-id>'
export ENTRA_DEV_CLIENT_ID='<authorized-public-client-application-id>'
node test_merge_risk_assessment.js --submit
```

An Entra administrator must configure the public-client application to allow
device-code authentication and grant the necessary delegated API permissions
and consent. Your user must also have scheduler access, and the API must support
delegated tokens. Do not use the managed identity client ID as the development
client ID. If the API only accepts application identities, run the integration
on its Azure host or obtain an authorized development service principal instead.

Follow the browser URL and device code printed in the terminal. The script does
not print the access token. It displays the HTTP status and raw response body,
and exits nonzero on configuration, authentication, network, or HTTP errors.
No arguments or `--help` only display help; `--submit` explicitly opts into
creating a **real production task** for PBI `40516754` through the GitHub-app
endpoint, without a `model` field.
Every invocation with `--submit` can create another task; this smoke test does
not use the bot's GitHub receipt deduplication or create GitHub comments.
It does not retry or follow HTTP redirects. An HTTP request or response-read
failure can leave submission status unknown; check the scheduler before retrying.
A 2xx response confirms submission, not completion of the assessment.

### Automatic reviewer assignment

For the sonic-mgmt pilot, non-draft open PRs receive reviewer requests on opening,
reopening, becoming ready for review, new commits, and base-branch changes.
Already-qualified paths need no additional requests. For each remaining path:

1. Prefer one eligible owner from the last matching CODEOWNERS rule. Request team
   owners as teams, not as individual members. Teams with no non-author human
   members are not eligible.
2. If no eligible code owner exists, select one reviewer with an individual score
   **at least 0.4** from the most-specific reviewer mapping. The approval policy
   still allows combined scores; assignment does not pick users below 0.4.
3. Reuse an existing matching request, then an already-selected reviewer; otherwise
   choose randomly among candidates. Deduplicate requests across paths. Never
   remove existing reviewer requests or reshuffle a still-outstanding request.

After covering unqualified paths, top up to **at least three outstanding review
requests**, counting each distinct user or team as one. Existing requests count
toward that total. Prefer additional CODEOWNERS, then mapped users with individual
scores at least 0.4 from the remaining unqualified changed paths. Request only
eligible candidates; if fewer than three exist, request those available. Do not
recruit unrelated or below-threshold reviewers, or add requests for paths that
already have qualified approval. Covering all paths may require more than three
requests; three is a minimum target, not a cap.

Auto-assignment is silent: it neither creates nor updates PR comments.
Before selecting candidates, the bot paginates repository collaborators and
checks repository access for referenced CODEOWNERS teams. Non-collaborators and
teams without access to the repository are excluded (including from minimum-three
top-ups); inaccessible owners can fall back to eligible mapped users. Bot users
are excluded from the collaborator list. Eligibility lookup failures other than
a team's 404 are surfaced, not treated as an empty success.
Selection logs use `[ REVIEWER ASSIGNMENT ]` and include excluded users, selected
user/team names, the planned total, and confirmation after GitHub accepts the
request. If GitHub rejects the request (for example after access changes), the
action queue reports the failure and the selected names remain visible in logs.
The author and bot accounts are excluded. Paths without candidates are left
unassigned instead of choosing below-threshold reviewers. Renames consider
both paths. API failures (including invalid/unrequestable owners) propagate through
the action queue; the bot does not silently substitute unrelated reviewers.
This does not change the most-specific-folder inheritance policy.

Deployment also requires **Pull requests: write** on the installed GitHub App
and bot token. Updating the manifest alone does not grant those permissions.

## Contributing

If you have suggestions for how event-collector could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2021 Xuhui Miao <xumia@microsoft.com>
