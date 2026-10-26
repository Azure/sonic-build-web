const mockEnqueueAction = jest.fn();
const mockGetGithubToken = jest.fn().mockResolvedValue("github-token");
const mockOctokit = jest.fn();
const mockRunBashAction = jest.fn().mockResolvedValue({ status: 0 });
jest.mock("../action_queue", () => ({
    enqueueAction: mockEnqueueAction,
    runBashAction: mockRunBashAction,
}));
jest.mock("../keyvault", () => ({
    getGithubToken: mockGetGithubToken,
    getSecretFromCache: jest.fn().mockResolvedValue("https://example.com/script.sh"),
}));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(function (options) { return mockOctokit(options); }),
}));
const backportLabels = require("../backport_labels");
const autoCherrypick = require("../auto_cherrypick");

const request = "Request for 202505 Branch";
const tested = "Tested for 202505 Branch";
const body = `### Backport
- [x] 202505
### Tested branch
- [x] 202505
### Test result
202505: https://example.com/results
`;
const event = (name, actor = "mssonicbld", kind = "labeled") => ({
    event: kind, label: { name }, actor: { login: actor },
});

describe("backport label reconciliation", () => {
    let octokit;
    let pr;
    let labels;
    let events;
    let comments;
    let changes;

    beforeEach(() => {
        jest.clearAllMocks();
        mockEnqueueAction.mockReset();
        pr = {
            state: "open", merged: false, body,
            base: { ref: "master" }, user: { login: "contributor" },
        };
        labels = [];
        events = [];
        comments = [];
        changes = [];
        const issues = {
            listLabelsOnIssue: jest.fn(),
            listEvents: jest.fn(),
            listComments: jest.fn(),
            addLabels: jest.fn(async params => {
                changes.push(["add", ...params.labels]);
            }),
            removeLabel: jest.fn(async params => {
                changes.push(["remove", params.name]);
            }),
            createComment: jest.fn().mockResolvedValue({}),
        };
        octokit = {
            rest: {
                issues,
                pulls: { get: jest.fn(async () => ({ data: pr })) },
            },
            paginate: jest.fn(async method => {
                if (method === issues.listLabelsOnIssue) return labels.map(name => ({ name }));
                if (method === issues.listEvents) return events;
                if (method === issues.listComments) return comments;
                throw new Error("Unexpected pagination call");
            }),
        };
        mockOctokit.mockReturnValue(octokit);
    });

    const sync = () => backportLabels.sync(octokit, "sonic-net", "sonic-buildimage", 42);

    test("adds tested labels successfully before adding request labels", async () => {
        await sync();
        expect(changes).toEqual([["add", tested], ["add", request]]);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain(`Added tested label(s): ${tested}. The corresponding branches are checked in the **Tested branch** section and have branch-specific test information in the **Test result** section of the PR description.`);
        expect(comment).toContain(`Added request label(s): ${request}. These branches are requested in the **Backport** section of the PR description, and their matching **Tested for** labels are now present.`);
    });

    test("handles each requested branch independently", async () => {
        pr.body = body.replace("- [x] 202505\n### Tested", "- [x] 202505\n202512\n### Tested");
        await sync();
        expect(changes).toEqual([["add", tested], ["add", request]]);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("branch(es): 202512, but is missing"),
        }));
    });

    test.each([
        body.replace("- [x] 202505\n### Test result", "- [ ] 202505\n### Test result"),
        body.replace("202505: https://example.com/results", ""),
        body.replace("202505: https://example.com/results", "12025050: results"),
        body.replace("202505: https://example.com/results", "<!-- 202505: hidden -->"),
        body.replace("202505: https://example.com/results", "202505"),
        body.replace("202505: https://example.com/results", "202505:"),
        body.replace("202505: https://example.com/results", "202505: <link to test results or summary with logs>"),
        body.replace("202505: https://example.com/results", "202505:\n```\n<test results>\n```"),
        body.replace("202505: https://example.com/results", "202505: &lt;test result&gt;"),
        body.replace("202505: https://example.com/results", "202505: **TBD**"),
        body.replace("202505: https://example.com/results", "202505: TODO"),
        body.replace("202505: https://example.com/results", "202505: pending"),
        body.replace("202505: https://example.com/results", "202505: ---"),
        body.replace("202505: https://example.com/results", "202505:\n202511: passed"),
        body.replace("202505: https://example.com/results", "Results for 202505"),
    ])("does not request a branch without both test requirements", async invalidBody => {
        pr.body = invalidBody;
        await sync();
        expect(changes).toEqual([]);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("missing required test information"),
        }));
    });

    test.each([
        "202505:\nhttps://example.com/results\nAll 12 tests passed.",
        "- 202505: 12 tests passed; logs: https://example.com/logs",
        "msft-202505: <https://example.com/results>",
        "202505:\n```text\n12/12 passed\n```",
    ])("accepts branch-specific evidence inline or on following lines: %s", async result => {
        pr.body = body.replace("202505: https://example.com/results", result);
        await sync();
        expect(changes).toEqual([["add", tested], ["add", request]]);
    });

    test("explains missing test information with an example for every affected branch", async () => {
        pr.body = "### Backport\n202505\n202512";
        await sync();
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain("**Update the PR description, not a PR comment:**");
        expect(comment).toContain("An unchecked box (`- [ ]`) does not count");
        expect(comment).toContain("replace every placeholder with your actual test evidence");
        expect(comment).toContain([
            "```markdown",
            "### Backport",
            "202505",
            "202512",
            "",
            "### Tested branch",
            "- [x] 202505",
            "- [x] 202512",
            "",
            "### Test result",
            "202505: <link to test results or summary with logs>",
            "202512: <link to test results or summary with logs>",
            "```",
        ].join("\n"));
        expect(comment).toContain("Keep this information outside HTML comments");
        expect(comment).toContain("`Tested for <branch> Branch` labels first, then the `Request for <branch> Branch` labels");
        expect(changes).toEqual([]);
    });

    test("does not treat the generated example copied unchanged as test evidence", async () => {
        pr.body = "### Backport\n202505\n202512";
        await sync();
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        pr.body = comment.match(/```markdown\n([\s\S]*?)\n```/)[1];
        octokit.rest.issues.createComment.mockClear();
        await sync();
        expect(changes).toEqual([]);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("branch(es): 202505, 202512, but is missing"),
        }));
    });

    test("does not use a later branch's multiline evidence for an earlier placeholder", async () => {
        pr.body = `### Backport
202505
202512
### Tested branch
- [x] 202505
- [x] 202512
### Test result
202505:
TBD
202512:
All tests passed.
Logs: https://example.com/results`;
        await sync();
        expect(changes).toEqual([
            ["add", "Tested for msft-202512 Branch"],
            ["add", "Request for msft-202512 Branch"],
        ]);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("branch(es): 202505, but is missing"),
        }));
    });

    test("ignores commented branches, unchecked requests and other sections", async () => {
        pr.body = `### Back port
<!--
202511
-->
- [ ] 202505
202512
### Unrelated
202411
### Tested branch
- [x] msft-202512
### Test result
202512: passed`;
        await sync();
        expect(changes).toEqual([
            ["add", "Tested for msft-202512 Branch"],
            ["add", "Request for msft-202512 Branch"],
        ]);
    });

    test("supports CRLF, case-insensitive headings and duplicate requests", async () => {
        pr.body = body.replace("### Backport", "#### BACKPORT\n202505").replace(/\n/g, "\r\n");
        await sync();
        expect(changes).toEqual([["add", tested], ["add", request]]);
    });

    test.each(["Included in", "Created PR to"])("does not request a completed backport: %s", async prefix => {
        labels = [`${prefix} 202505 Branch`];
        await sync();
        expect(changes).toEqual([["add", tested]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain(`Added tested label(s): ${tested}`);
        expect(comment).not.toContain("Added request label(s)");
    });

    test("removes a manual request without its matching tested label", async () => {
        pr.body = null;
        labels = [request, "Tested for 202511 Branch"];
        events = [event(request, "maintainer")];
        await sync();
        expect(changes).toEqual([["remove", request]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain(`- \`${request}\`: The matching \`${tested}\` label is missing.`);
        expect(comment).toContain("This requirement also applies to manually added request labels.");
        expect(comment).toContain("**Update the PR description, not a PR comment:**");
        expect(comment).toContain("- [x] 202505");
        expect(comment).toContain("202505: <link to test results or summary with logs>");
        expect(comment).not.toContain("no longer listed");
    });

    test.each(["", "202505: <link to test results or summary with logs>"])("removes the request before invalidated bot-owned tested evidence: %s", async result => {
        pr.body = body.replace("202505: https://example.com/results", result);
        labels = [tested, request];
        events = [event(tested), event(request, "maintainer")];
        await sync();
        expect(changes).toEqual([["remove", request], ["remove", tested]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain(`- \`${request}\`: The matching \`${tested}\` label is also being removed for the reason listed below.`);
        expect(comment).toContain(`- \`${tested}\`: Branch \`202505\` no longer has both a checked checkbox in **Tested branch** and branch-specific evidence in **Test result**.`);
        expect(comment).toContain("- [x] 202505");
        expect(comment.split("**Update the PR description, not a PR comment:**")).toHaveLength(2);
        expect(comment).not.toContain("label is missing");
    });

    test("cleans up legacy bot labels when a backport is removed", async () => {
        pr.body = "";
        labels = [request, tested];
        events = [event(request), event(tested)];
        await sync();
        expect(changes).toEqual([["remove", request], ["remove", tested]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        for (const name of [request, tested]) {
            expect(comment).toContain(`- \`${name}\`: Branch \`202505\` is no longer listed in the **Backport** section`);
        }
        expect(comment).toContain("Add it back there if you still need this backport.");
        expect(comment).not.toContain("label is missing");
    });

    test("explains internal-branch label removal using raw branch numbers in instructions", async () => {
        pr.body = "";
        labels = ["Request for msft-202512 Branch"];
        events = [event(labels[0], "maintainer")];
        await sync();
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain("The matching `Tested for msft-202512 Branch` label is missing.");
        expect(comment).toContain("### Backport\n202512");
        expect(comment).toContain("- [x] 202512");
        expect(comment).toContain("202512: <link to test results or summary with logs>");
    });

    test("reuses the same missing-test guidance when a request label is removed", async () => {
        pr.body = "### Backport\n202505";
        await sync();
        const reminder = octokit.rest.issues.createComment.mock.calls[0][0].body;
        octokit.rest.issues.createComment.mockClear();
        labels = [request];
        events = [event(request, "maintainer")];
        comments = [{ user: { login: "mssonicbld" }, body: reminder }];
        await sync();
        const removalComment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(removalComment).toContain(`- \`${request}\`: The matching \`${tested}\` label is missing.`);
        expect(removalComment).toContain(reminder);
        expect(removalComment.split("Example format for the branches above")).toHaveLength(2);
    });

    test("repairs a missing tested label without removing and re-adding the request", async () => {
        labels = [request];
        events = [event(request, "maintainer")];
        await sync();
        expect(changes).toEqual([["add", tested]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).not.toContain("missing required test information");
        expect(comment).not.toContain("Removed label(s)");
    });

    test("does not repair a request using a different label branch prefix", async () => {
        const internalRequest = "Request for msft-202505 Branch";
        labels = [internalRequest];
        events = [event(internalRequest, "maintainer")];
        await sync();
        expect(changes).toEqual([
            ["add", tested], ["remove", internalRequest], ["add", request],
        ]);
    });

    test("preserves manually reapplied labels instead of claiming old bot ownership", async () => {
        pr.body = "";
        labels = [request, tested];
        events = [
            event(tested), event(tested, "maintainer", "unlabeled"), event(tested, "maintainer"),
            event(request, "maintainer"),
        ];
        await sync();
        expect(changes).toEqual([]);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("accepts manually verified tested labels as the request prerequisite", async () => {
        pr.body = "### Backport\n202505";
        labels = [tested];
        events = [event(tested, "maintainer")];
        await sync();
        expect(changes).toEqual([["add", request]]);
        const comment = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(comment).toContain(`Added request label(s): ${request}`);
        expect(comment).toContain("their matching **Tested for** labels are now present");
        expect(comment).not.toContain("Added tested label(s)");
        expect(comment).not.toContain("branches are checked");
    });

    test("does not repeat missing-test reminders already posted by the pipeline", async () => {
        pr.body = "### Backport\n202505";
        comments = [{
            user: { login: "mssonicbld" },
            body: "This PR has backport request label(s) for branch(es): 202505,msft-202512, but is missing required test information. Please make sure you tick the tested branch(es).",
        }];
        await sync();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(octokit.paginate).toHaveBeenCalledWith(
            octokit.rest.issues.listComments,
            expect.objectContaining({ per_page: 100 }),
        );
    });

    test("recognizes internal branches in legacy pipeline reminder lists", async () => {
        pr.body = "### Backport\n202512";
        comments = [{
            user: { login: "mssonicbld" },
            body: "This PR has backport request label(s) for branch(es): 202505,msft-202512, but is missing required test information.",
        }];
        await sync();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("does not mistake added branches in a combined comment for missing-test reminders", async () => {
        pr.body = body.replace("- [x] 202505\n### Tested", "- [x] 202505\n202512\n### Tested");
        await sync();
        const combined = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(combined).toContain(`Added tested label(s): ${tested}`);
        expect(combined).toContain("branch(es): 202512, but is missing");
        comments = [{ user: { login: "mssonicbld" }, body: combined }];
        octokit.rest.issues.createComment.mockClear();
        pr.body = "### Backport\n202505\n202512";
        await sync();
        const reminder = octokit.rest.issues.createComment.mock.calls[0][0].body;
        expect(reminder).toContain("branch(es): 202505, but is missing");
        expect(reminder).not.toContain("branch(es): 202512, but is missing");
    });

    test("does not trust reminders from other users", async () => {
        pr.body = "### Backport\n202505";
        comments = [{
            user: { login: "contributor" },
            body: "This PR requests backports for branch(es): 202505, but is missing required test information.",
        }];
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    test("never adds a request when adding its tested label fails", async () => {
        octokit.rest.issues.addLabels.mockRejectedValue(new Error("Label unavailable"));
        await expect(sync()).rejects.toThrow("Label unavailable");
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({
            labels: [tested],
        }));
    });

    test("does not remove tested labels when request removal fails", async () => {
        pr.body = "";
        labels = [request, tested];
        events = [event(request), event(tested)];
        octokit.rest.issues.removeLabel.mockRejectedValue(new Error("GitHub unavailable"));
        await expect(sync()).rejects.toThrow("GitHub unavailable");
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({
            name: request,
        }));
    });

    test.each(["release", "bot", "closed"])("skips automatic description labels for %s PRs", async kind => {
        if (kind === "release") pr.base.ref = "202505";
        if (kind === "bot") pr.user.login = "mssonicbld";
        if (kind === "closed") pr.state = "closed";
        await sync();
        expect(changes).toEqual([]);
    });

    test("still reconciles merged PRs", async () => {
        pr.state = "closed";
        pr.merged = true;
        await sync();
        expect(changes).toEqual([["add", tested], ["add", request]]);
    });

    test("is idempotent when current labels already match", async () => {
        labels = [request.toLowerCase(), tested.toLowerCase()];
        events = labels.map(name => event(name));
        await sync();
        expect(changes).toEqual([]);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test.each(["labeled", "synchronize"])("processes a request once across generated webhooks after %s", async action => {
        const handlers = new Map();
        const tasks = [];
        mockEnqueueAction.mockImplementation(task => { tasks.push(task); });
        const app = {
            log: { info: jest.fn(), error: jest.fn() },
            on: (names, handler) => {
                for (const name of names) {
                    handlers.set(name, [...(handlers.get(name) || []), handler]);
                }
            },
        };
        backportLabels.init(app);
        autoCherrypick.init(app);
        const emit = async (action, name, sender = "mssonicbld") => {
            const payload = {
                action, number: 42, label: { name }, sender: { login: sender },
                repository: {
                    full_name: "sonic-net/sonic-buildimage",
                    name: "sonic-buildimage", owner: { login: "sonic-net" },
                },
                pull_request: { ...pr, labels: labels.map(name => ({ name })) },
            };
            for (const handler of handlers.get(`pull_request.${action}`) || []) {
                await handler({ payload });
            }
        };
        octokit.rest.issues.addLabels.mockImplementation(async params => {
            changes.push(["add", ...params.labels]);
            for (const name of params.labels) {
                labels.push(name);
                events.push(event(name));
                await emit("labeled", name);
            }
        });
        if (action === "labeled") {
            labels = [request];
            events = [event(request, "maintainer")];
        }
        await emit(action, request, "maintainer");
        while (tasks.length) {
            await tasks.shift()();
        }
        const requestRuns = mockRunBashAction.mock.calls.filter(([params]) =>
            params.includes(`ACTION_LABEL="${request}"`) ||
            (params.includes("ACTION=synchronize") &&
                params.some(param => param.startsWith("PR_LABELS=") && param.includes(request))));
        expect(requestRuns).toHaveLength(1);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    test("queues fresh reads for description edits without running a script", async () => {
        let handler;
        const app = { on: jest.fn((events, callback) => { handler = callback; }) };
        backportLabels.init(app);
        expect(app.on.mock.calls[0][0]).toContain("pull_request.edited");
        const payload = {
            action: "edited", number: 42, changes: { body: { from: "" } },
            repository: {
                full_name: "sonic-net/sonic-buildimage",
                name: "sonic-buildimage", owner: { login: "sonic-net" },
            },
            pull_request: pr,
        };
        await handler({ payload });
        expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
        await mockEnqueueAction.mock.calls[0][0]();
        expect(mockGetGithubToken).toHaveBeenCalled();
        expect(octokit.rest.pulls.get).toHaveBeenCalled();
        expect(changes).toEqual([["add", tested], ["add", request]]);
    });

    test.each(["title", "unrelated-label", "other-repo", "closed"])("does not queue %s events", async kind => {
        let handler;
        backportLabels.init({ on: (events, callback) => { handler = callback; } });
        const payload = {
            action: "edited", changes: { title: { from: "" } }, number: 42,
            repository: { full_name: "sonic-net/sonic-buildimage" }, pull_request: pr,
        };
        if (kind === "unrelated-label") {
            payload.action = "unlabeled";
            payload.label = { name: "bug" };
        }
        if (kind === "other-repo") payload.repository.full_name = "other/repo";
        if (kind === "closed") payload.action = "closed";
        await handler({ payload });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });
});
