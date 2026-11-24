const mockEnqueueAction = jest.fn();
const mockGetGithubToken = jest.fn();
const mockOctokit = jest.fn();
const mockSubmitMergeRiskAssessment = jest.fn();
jest.mock("../action_queue", () => ({ enqueueAction: mockEnqueueAction }));
jest.mock("../keyvault", () => ({ getGithubToken: mockGetGithubToken }));
jest.mock("../merge_risk_assessment", () => ({ submit: mockSubmitMergeRiskAssessment }));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(function (options) { return mockOctokit(options); }),
}));
const qualifiedApprovals = require("../qualified_approvals");

const marker = "<!-- sonic-qualified-approval-coverage -->";
const mappingText = `/: {RootOwner: 0.6}
/tests/: {Alice: 0.5, Bob: 0.7}
/tests/special/: {Carol: 0.6}
/tests/blocked/: {}
/ansible/: {Bob: 0.5}
`;
const review = (login, state = "APPROVED", commit = "head", id = 1) => ({
    id, user: { login, type: "User" }, state, commit_id: commit,
    submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
});

describe("qualified approval coverage", () => {
    let octokit;
    let pr;
    let source;
    let files;
    let reviews;
    let comments;
    let collaborators;
    let labelEvents;

    beforeEach(() => {
        jest.clearAllMocks();
        pr = {
            state: "open", number: 42, head: { sha: "head" }, base: { sha: "base", ref: "master" },
            user: { login: "author" }, changed_files: 1, labels: [],
        };
        source = {
            type: "file", encoding: "base64",
            content: Buffer.from(mappingText).toString("base64"),
        };
        files = [{ filename: "tests/test_one.py", status: "modified" }];
        reviews = [];
        comments = [];
        labelEvents = [];
        collaborators = [{ login: "Alice", type: "User" }, { login: "Bob", type: "User" }];
        const pulls = {
            get: jest.fn(async () => ({ data: pr })),
            listFiles: jest.fn(), listReviews: jest.fn(),
            requestReviewers: jest.fn().mockResolvedValue({}),
        };
        const issues = {
            listComments: jest.fn(),
            listEvents: jest.fn(),
            createComment: jest.fn().mockResolvedValue({}),
            updateComment: jest.fn().mockResolvedValue({}),
            addLabels: jest.fn(async ({ labels }) => {
                pr.labels.push(...labels.map(name => ({ name })));
            }),
            removeLabel: jest.fn(async ({ name }) => {
                pr.labels = pr.labels.filter(label => label.name !== name);
            }),
        };
        octokit = {
            rest: {
                pulls, issues,
                repos: {
                    listCollaborators: jest.fn(),
                    getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "write" } }),
                    getContent: jest.fn(async params => {
                    if (params.path === ".github/CODEOWNERS") {
                        throw Object.assign(new Error("Not found"), { status: 404 });
                    }
                    return { data: source };
                }) },
            },
            paginate: jest.fn(async method => {
                if (method === pulls.listFiles) return files;
                if (method === pulls.listReviews) return reviews;
                if (method === issues.listComments) return comments;
                if (method === issues.listEvents) return labelEvents;
                if (method === octokit.rest.repos.listCollaborators) return collaborators;
                throw new Error("Unexpected pagination method");
            }),
        };
        mockOctokit.mockReturnValue(octokit);
        mockGetGithubToken.mockResolvedValue("bot-token");
        mockEnqueueAction.mockReset();
        mockSubmitMergeRiskAssessment.mockReset();
    });

    const sync = () => qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42);
    const body = () => octokit.rest.issues.createComment.mock.calls[0][0].body;
    const noComment = () => {
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    };

    test("assignment requests qualified reviewers without reading or writing comments", async () => {
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", pull_number: 42,
            reviewers: expect.arrayContaining(["alice", "bob"]), team_reviewers: [],
        });
        noComment();
        expect(octokit.paginate).not.toHaveBeenCalledWith(
            octokit.rest.issues.listComments, expect.anything(),
        );
    });

    test("does not re-request outstanding reviewers", async () => {
        pr.requested_reviewers = [{ login: "Alice" }, { login: "Bob" }, { login: "Existing" }];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("filters non-collaborators before requesting reviewers", async () => {
        collaborators = [{ login: "Bob", type: "User" }];
        const log = { info: jest.fn(), warn: jest.fn() };
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true, log);
        expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(expect.objectContaining({
            reviewers: ["bob"], team_reviewers: [],
        }));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("excluded non-collaborators: alice"));
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("review requests accepted"));
        noComment();
    });

    test("surfaces eligibility lookup failures without requesting reviewers", async () => {
        octokit.paginate.mockImplementation(async method => {
            if (method === octokit.rest.repos.listCollaborators) throw new Error("Cannot list collaborators");
            if (method === octokit.rest.pulls.listFiles) return files;
            if (method === octokit.rest.pulls.listReviews) return reviews;
            throw new Error("Unexpected pagination method");
        });
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true))
            .rejects.toThrow("Cannot list collaborators");
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("does not assign drafts", async () => {
        pr.draft = true;
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("assignment failures propagate without claiming success", async () => {
        octokit.rest.pulls.requestReviewers.mockRejectedValue(new Error("Cannot request reviewer"));
        const log = { info: jest.fn(), warn: jest.fn() };
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true, log))
            .rejects.toThrow("Cannot request reviewer");
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reviewers="));
        const selection = log.info.mock.calls[0][0];
        expect(selection).toContain('"alice"');
        expect(selection).toContain('"bob"');
        expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("review requests accepted"));
        noComment();
    });

    test("reports approval and pending coverage from multiple qualified users", async () => {
        files.push({ filename: "ansible/task.yml" }, { filename: "tests/special/test_two.py" });
        pr.changed_files = 3;
        reviews = [review("alice"), review("BOB", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**2 of 3 changed files have qualified approval**");
        expect(body()).toContain("| <code>/tests/</code> | 1 | <code>/tests/</code> | Approved | @Alice, @Bob |");
        expect(body()).toContain("| <code>/ansible/</code> | 1 | <code>/ansible/</code> | Approved | @Bob |");
        expect(body()).toContain("| <code>/tests/special/</code> | 1 | <code>/tests/special/</code> | Awaiting qualified approval | - |");
        expect(body()).toContain("[Reviewer mapping](https://github.com/sonic-net/sonic-tsc/blob/master/pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml)");
        expect(body()).toContain("does not yet meet the qualified-approval requirement for auto-merge");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    test("labels complete coverage and announces the auto-merge approval requirement", async () => {
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, labels: ["Qualified-approval"],
        });
        expect(body()).toContain("**All changed folders have qualified approval.**");
        expect(body()).toContain("meets the qualified-approval requirement for auto-merge");
        expect(body()).toContain("including required checks, branch protection");
        expect(body()).toContain("does not enable auto-merge or merge the PR");
        await sync();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    });

    test("preserves existing matching labels regardless of case", async () => {
        pr.labels = [{ name: "qualified-approval" }, { name: "unrelated" }];
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    test("requests assessment for complete coverage even with an existing label", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice")];
        await sync();
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledWith(
            octokit, "sonic-net", "sonic-mgmt", pr, console,
        );
    });

    test("an unmapped administrator qualifies all paths, including both sides of a rename", async () => {
        files = [
            { filename: "tests/blocked/file.py" },
            { filename: "unknown/new.py", previous_filename: "elsewhere/old.py", status: "renamed" },
        ];
        pr.changed_files = files.length;
        reviews = [review("YijingYan2")];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "admin" } });
        await sync();
        expect(body()).toContain("**2 of 2 changed files have qualified approval**");
        expect(body()).toContain("Approving repository administrators: @yijingyan2.");
        expect(body()).toContain("| Approved | - | 0 | - |");
        expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", username: "yijingyan2",
        });
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledTimes(1);
    });

    test.each(["stale", "dismissed", "changes requested", "author", "bot", "requested"])(
        "does not allow a %s administrator approval to qualify", async reason => {
            reviews = [review("Admin")];
            if (reason === "stale") reviews[0].commit_id = "previous-head";
            else if (reason === "dismissed") reviews.push(review("Admin", "DISMISSED", "head", 2));
            else if (reason === "changes requested") reviews.push(review("Admin", "CHANGES_REQUESTED", "head", 2));
            else if (reason === "author") pr.user.login = "ADMIN";
            else if (reason === "bot") reviews[0].user.type = "Bot";
            else pr.requested_reviewers = [{ login: "ADMIN" }];
            octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "admin" } });
            await sync();
            expect(body()).toContain("**0 of 1");
            expect(body()).toContain("Approving repository administrators: -.");
            expect(octokit.rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
            expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
            expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        },
    );

    test("administrator coverage prevents additional reviewer assignment", async () => {
        reviews = [review("Admin")];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "admin" } });
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledTimes(1);
        noComment();
    });

    test("administrator approval does not qualify an empty changed-file list", async () => {
        files = [];
        pr.changed_files = 0;
        reviews = [review("Admin")];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: "admin" } });
        await sync();
        expect(body()).toContain("**0 of 0");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
    });

    test("losing administrator permission removes qualification and bot-owned automerge", async () => {
        reviews = [review("Admin")];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({ data: { permission: "admin" } });
        await sync();
        pr.labels.push({ name: "automerge" });
        labelEvents = [labelEvent(1, "mssonicbld")];
        await sync();
        expect(pr.labels).toEqual([]);
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledTimes(1);
    });

    test("administrator permission lookup failures do not publish or change labels", async () => {
        reviews = [review("Admin")];
        pr.labels = [{ name: "Qualified-approval" }, { name: "automerge" }];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(new Error("Cannot check administrator permission"));
        await expect(sync()).rejects.toThrow("Cannot check administrator permission");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("rechecks PR freshness after the administrator permission lookup", async () => {
        reviews = [review("Admin")];
        octokit.rest.repos.getCollaboratorPermissionLevel.mockImplementation(async () => {
            pr = { ...pr, requested_reviewers: [{ login: "Admin" }] };
            return { data: { permission: "admin" } };
        });
        await expect(sync()).rejects.toThrow("skipping stale summary");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("requests assessment on silent qualified lifecycle updates", async () => {
        reviews = [review("Alice")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledTimes(1);
        noComment();
    });

    test("does not request assessment for partial or empty coverage", async () => {
        await sync();
        files = [];
        pr.changed_files = 0;
        await sync();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
    });

    test("surfaces assessment failures while preserving the qualified label and summary", async () => {
        reviews = [review("Alice")];
        mockSubmitMergeRiskAssessment.mockRejectedValue(new Error("Cluster unavailable"));
        await expect(sync()).rejects.toThrow("Cluster unavailable");
        expect(pr.labels).toContainEqual({ name: "Qualified-approval" });
        expect(body()).toContain("**All changed folders have qualified approval.**");
    });

    test("does not qualify an empty PR", async () => {
        files = [];
        pr.changed_files = 0;
        await sync();
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(body()).not.toContain("**All changed folders have qualified approval.**");
    });

    test("removes a stale label on synchronize even if reviewer access lookup fails", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "unrelated" }];
        reviews = [review("Alice", "APPROVED", "previous-head")];
        const paginate = octokit.paginate.getMockImplementation();
        octokit.paginate.mockImplementation(async (method, params) => {
            if (method === octokit.rest.repos.listCollaborators) throw new Error("Cannot list collaborators");
            return paginate(method, params);
        });
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true))
            .rejects.toThrow("Cannot list collaborators");
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, name: "Qualified-approval",
        });
        expect(pr.labels).toEqual([{ name: "unrelated" }]);
        noComment();
    });

    test.each(["addLabels", "removeLabel"])("surfaces %s failures without a misleading comment", async method => {
        if (method === "addLabels") reviews = [review("Alice")];
        else pr.labels = [{ name: "Qualified-approval" }];
        octokit.rest.issues[method].mockRejectedValue(new Error("Cannot update label"));
        await expect(sync()).rejects.toThrow("Cannot update label");
        noComment();
    });

    const labelEvent = (id, login, event = "labeled", name = "automerge") => ({
        id, event, actor: { login }, label: { name },
    });

    test("removes bot-added automerge together with lost qualification", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "AutoMerge" }, { name: "unrelated" }];
        labelEvents = [labelEvent(1, "MSSonicBld", "labeled", "AutoMerge")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(octokit.rest.issues.removeLabel.mock.calls.map(([params]) => params.name))
            .toEqual(["Qualified-approval", "AutoMerge"]);
        expect(pr.labels).toEqual([{ name: "unrelated" }]);
        expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listEvents, {
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, per_page: 100,
        });
        noComment();
    });

    test.each([false, true])("preserves submodule bot-added automerge without prior qualification (assign=%s)", async assign => {
        pr.labels = [{ name: "automerge" }];
        labelEvents = [labelEvent(1, "mssonicbld")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, assign, console, false);
        expect(pr.labels).toEqual([{ name: "automerge" }]);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.issues.listEvents, expect.anything());
    });

    test.each([
        [],
        [labelEvent(1, "human")],
        [labelEvent(3, "human"), labelEvent(1, "mssonicbld"), labelEvent(2, "human", "unlabeled")],
        [labelEvent(1, "mssonicbld"), labelEvent(2, "human", "unlabeled")],
        [{ id: 1, event: "labeled", label: { name: "automerge" } }],
    ])("preserves automerge without a current bot-authored addition: %p", async (...events) => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "automerge" }];
        labelEvents = events;
        await sync();
        expect(pr.labels).toEqual([{ name: "automerge" }]);
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
    });

    test("uses the latest automerge addition rather than an older human addition", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "automerge" }];
        labelEvents = [
            labelEvent(1, "human"), labelEvent(2, "human", "unlabeled"),
            labelEvent(3, "mssonicbld"), labelEvent(4, "human", "labeled", "unrelated"),
        ];
        await sync();
        expect(pr.labels).toEqual([]);
    });

    test("preserves automerge while coverage still qualifies", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "automerge" }];
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.issues.listEvents, expect.anything());
    });

    test.each(["history", "removal"])("surfaces automerge %s failures and retries on the qualification removal webhook", async stage => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "automerge" }];
        labelEvents = [labelEvent(1, "mssonicbld")];
        if (stage === "history") {
            const paginate = octokit.paginate.getMockImplementation();
            octokit.paginate.mockImplementationOnce(paginate).mockImplementationOnce(paginate)
                .mockRejectedValueOnce(new Error("Cannot read label events"));
        } else {
            const remove = octokit.rest.issues.removeLabel.getMockImplementation();
            octokit.rest.issues.removeLabel.mockImplementationOnce(remove)
                .mockRejectedValueOnce(new Error("Cannot remove automerge"));
        }
        await expect(sync()).rejects.toThrow(stage === "history" ? "Cannot read label events" : "Cannot remove automerge");
        expect(pr.labels).toEqual([{ name: "automerge" }]);
        noComment();
        const run = await qualificationRemoval();
        await run();
        expect(pr.labels).toEqual([]);
    });

    const qualificationRemoval = async () => {
        const app = { on: jest.fn(), log: { info: jest.fn() } };
        qualifiedApprovals.init(app);
        const [events, handler] = app.on.mock.calls[0];
        expect(events).toContain("pull_request.unlabeled");
        await handler({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "unlabeled", label: { name: "qualified-APPROVAL" },
        } });
        return mockEnqueueAction.mock.calls[0][0];
    };

    test("handles qualification removal webhooks without recalculating or re-adding qualification", async () => {
        pr.labels = [{ name: "automerge" }];
        reviews = [review("Alice")];
        labelEvents = [labelEvent(1, "mssonicbld")];
        const run = await qualificationRemoval();
        await run();
        await run();
        expect(pr.labels).toEqual([]);
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test.each(["qualified", "closed", "retargeted", "automerge removed"])(
        "does not remove automerge if PR becomes %s during history lookup", async change => {
            pr.labels = [{ name: "automerge" }];
            labelEvents = [labelEvent(1, "mssonicbld")];
            const paginate = octokit.paginate.getMockImplementation();
            octokit.paginate.mockImplementation(async (method, params) => {
                const result = await paginate(method, params);
                if (change === "qualified") pr.labels.push({ name: "Qualified-approval" });
                else if (change === "closed") pr.state = "closed";
                else if (change === "retargeted") pr.base.ref = "202511";
                else pr.labels = [];
                return result;
            });
            const run = await qualificationRemoval();
            await run();
            expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        },
    );

    test("skips a delayed removal webhook if qualification has been restored", async () => {
        pr.labels = [{ name: "automerge" }];
        const run = await qualificationRemoval();
        pr.labels.push({ name: "Qualified-approval" });
        await run();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalled();
    });

    test("ignores removal webhooks for other labels", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt" },
            pull_request: pr, action: "unlabeled", label: { name: "automerge" },
        } });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });

    test("loads only the trusted master mapping and paginates every collection", async () => {
        await sync();
        expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-tsc", ref: "master",
            path: "pr_reviewer/sonic-mgmt/pr_reviewer-by-files.yml",
        });
        expect(octokit.paginate).toHaveBeenCalledTimes(2);
        for (const [, params] of octokit.paginate.mock.calls) {
            expect(params.per_page).toBe(100);
        }
    });

    test.each([
        [0.2, 0.19, false],
        [0.2, 0.2, true],
        [0.2, 0.2001, true],
        [0.4, 0, true],
        [0.4001, 0, true],
    ])("qualifies when approver scores %s + %s reach 0.4", async (alice, bob, qualified) => {
        source.content = Buffer.from(`/tests/: {Alice: ${alice}, Bob: ${bob}}`).toString("base64");
        reviews = [review("Alice"), review("BOB", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain(`**${qualified ? 1 : 0} of 1`);
        expect(body()).toContain(`| ${qualified ? "Approved" : "Awaiting qualified approval"} | @Alice, @Bob |`);
        expect(body()).toContain("exactly 0.4 qualifies");
    });

    test("counts each active mapped approver once and excludes inactive and unmapped scores", async () => {
        source.content = Buffer.from("/tests/: {Alice: 0.2, Bob: 0.3, Carol: 0.3, author: 0.9}").toString("base64");
        reviews = [
            review("Alice"), review("alice", "APPROVED", "head", 2),
            review("Bob", "APPROVED", "old-head", 3),
            review("Carol", "APPROVED", "head", 4), review("Carol", "DISMISSED", "head", 5),
            review("author", "APPROVED", "head", 6), review("Unmapped", "APPROVED", "head", 7),
        ];
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(body()).toContain("| Awaiting qualified approval | @Alice | 0.2 |");
    });

    test("does not pool approver scores across folders", async () => {
        source.content = Buffer.from("/tests/: {Alice: 0.3}\n/ansible/: {Bob: 0.3}").toString("base64");
        files.push({ filename: "ansible/task.yml" });
        pr.changed_files = 2;
        reviews = [review("Alice"), review("Bob", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**0 of 2");
    });

    test("decimal scores totaling exactly 0.4 qualify", async () => {
        const users = Array.from({ length: 40 }, (_, i) => `Reviewer${i}`);
        source.content = Buffer.from(`/tests/: {${users.map(login => `${login}: 0.01`).join(", ")}}`).toString("base64");
        reviews = users.map((login, i) => review(login, "APPROVED", "head", i + 1));
        await sync();
        expect(body()).toContain("**1 of 1");
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(body()).toContain("| 0.4 |");
    });

    test("inherits the nearest parent mapping, but not beyond a specific entry", async () => {
        files = [
            { filename: "tests/new/deeper/file.py" },
            { filename: "tests/special/deeper/file.py" },
            { filename: "tests/blocked/file.py" },
        ];
        pr.changed_files = 3;
        reviews = [review("Alice"), review("RootOwner", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 3");
        expect(body()).toContain("| <code>/tests/new/deeper/</code> | 1 | <code>/tests/</code> | Approved");
        expect(body()).toContain("| <code>/tests/blocked/</code> | 1 | <code>/tests/blocked/</code> | Awaiting");
    });

    test("uses the root mapping for root files and unmapped descendants", async () => {
        files = [{ filename: "README.md" }, { filename: "new/file.txt" }];
        pr.changed_files = 2;
        reviews = [review("RootOwner")];
        await sync();
        expect(body()).toContain("**2 of 2");
        expect(body()).toContain("| <code>/</code> | 1 | <code>/</code> | Approved");
    });

    test("distinguishes absent mappings from pending approval", async () => {
        source.content = Buffer.from("/ansible/: {Bob: 0.5}").toString("base64");
        reviews = [review("Bob")];
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(body()).toContain("| <code>/tests/</code> | 1 | - | No reviewer mapping | - |");
    });

    test.each(["old-head", null])("does not count approval for commit %s", async commit => {
        reviews = [review("Alice", "APPROVED", commit)];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["CHANGES_REQUESTED", "DISMISSED"])("revokes earlier approvals after %s", async state => {
        reviews = [review("alice", state, "head", 9), review("Alice", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["COMMENTED", "PENDING"])("does not replace approval with a %s review", async state => {
        reviews = [review("Alice"), review("alice", state, "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("a newer approval replaces changes requested", async () => {
        reviews = [review("Alice", "CHANGES_REQUESTED"), review("alice", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("uses submission time rather than review creation order", async () => {
        const approval = review("Alice", "APPROVED", "head", 1);
        approval.submitted_at = "2026-02-01T00:00:00Z";
        reviews = [review("Alice", "CHANGES_REQUESTED", "head", 2), approval];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("rejects decisive reviews with missing submission timestamps", async () => {
        reviews = [{ ...review("Alice"), submitted_at: null }];
        await expect(sync()).rejects.toThrow("submission time");
        noComment();
    });

    test.each(["author", "bot", "unqualified"])("excludes %s approvals", async kind => {
        const user = review(kind === "unqualified" ? "Stranger" : "Alice");
        if (kind === "author") pr.user.login = "ALICE";
        if (kind === "bot") user.user.type = "Bot";
        reviews = [user];
        await sync();
        expect(body()).toContain("**0 of 1");
    });

    test.each(["removed", "added"])("includes %s files", async status => {
        files[0].status = status;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("renames require old and new path coverage without double-counting", async () => {
        files = [{
            filename: "ansible/renamed.py", previous_filename: "tests/original.py", status: "renamed",
        }];
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**0 of 1");
        reviews.push(review("Bob", "APPROVED", "head", 2));
        octokit.rest.issues.createComment.mockClear();
        await sync();
        expect(body()).toContain("**1 of 1");
    });

    test("posts new coverage snapshots even when an identical previous comment exists", async () => {
        await sync();
        const original = body();
        comments = [
            { id: 10, user: { login: "someone" }, body: original },
            { id: 11, user: { login: "mssonicbld" }, body: "Other bot comment" },
            { id: 12, user: { login: "mssonicbld" }, body: original },
        ];
        octokit.rest.issues.createComment.mockClear();
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(body()).toBe(original);
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenLastCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42,
            body: expect.stringContaining("**1 of 1"),
        });
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.issues.listComments, expect.anything());
    });

    test("does not trust another user's marked comment", async () => {
        comments = [{ id: 10, user: { login: "someone" }, body: marker }];
        await sync();
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });

    test.each([
        "", "[]", "/tests/: [Alice]", "/tests/: {Alice: bad}", "/tests/: {Alice: 2}",
        "/tests/: {Alice: -1}", "tests/: {Alice: 0.6}", "/tests/../: {Alice: 0.6}",
        "/tests/: {'<invalid>': 0.6}", "/tests/: {Alice: 0.6}\n/tests/: {Bob: 0.5}",
    ])("surfaces malformed mapping %s without publishing", async text => {
        source.content = Buffer.from(text).toString("base64");
        await expect(sync()).rejects.toThrow();
        noComment();
    });

    test("surfaces unavailable mapping rather than reporting false coverage", async () => {
        octokit.rest.repos.getContent.mockRejectedValue(new Error("Mapping not found"));
        await expect(sync()).rejects.toThrow("Mapping not found");
        noComment();
    });

    test("rejects unsupported mapping response formats", async () => {
        source.encoding = "none";
        await expect(sync()).rejects.toThrow("not a readable file");
        noComment();
    });

    test("rejects truncated GitHub file lists", async () => {
        pr.changed_files = 3001;
        await expect(sync()).rejects.toThrow("Incomplete changed-file list");
        noComment();
    });

    test("surfaces file-list API failures", async () => {
        octokit.paginate.mockRejectedValue(new Error("GitHub unavailable"));
        await expect(sync()).rejects.toThrow("GitHub unavailable");
        noComment();
    });

    test.each(["head", "base", "target", "closed"])("avoids publishing after PR %s changes", async change => {
        const current = { ...pr, head: { ...pr.head }, base: { ...pr.base } };
        if (change === "closed") current.state = "closed";
        else if (change === "target") current.base.ref = "202511";
        else current[change].sha = "new-sha";
        octokit.rest.pulls.get.mockResolvedValueOnce({ data: pr }).mockResolvedValueOnce({ data: current });
        await expect(sync()).rejects.toThrow("skipping stale summary");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test.each([false, true])("skips non-master PRs before loading coverage or assigning reviewers (assign=%s)", async assign => {
        pr.base.ref = "202511";
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, assign);
        expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalled();
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("skips a queued master event if the PR has since been retargeted", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "opened",
        } });
        pr.base.ref = "202511";
        await mockEnqueueAction.mock.calls[0][0]();
        expect(octokit.paginate).not.toHaveBeenCalled();
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("rechecks the target branch after loading reviewer access", async () => {
        const retargeted = { ...pr, base: { ...pr.base, ref: "202511" } };
        octokit.rest.pulls.get.mockResolvedValueOnce({ data: pr })
            .mockResolvedValueOnce({ data: pr }).mockResolvedValueOnce({ data: retargeted });
        await expect(qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, true))
            .rejects.toThrow("skipping stale summary");
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("skips closed PRs", async () => {
        pr.state = "closed";
        await sync();
        expect(octokit.paginate).not.toHaveBeenCalled();
        noComment();
    });

    test("limits table size but counts every changed file", async () => {
        files = Array.from({ length: 110 }, (_, i) => ({ filename: `tests/sub${i}/file.py` }));
        pr.changed_files = files.length;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**110 of 110");
        expect(body()).toContain("Showing 100 of 110 changed folders");
        expect(body().split("\n").filter(line => line.startsWith("| <code>"))).toHaveLength(100);
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
    });

    test("does not label partial coverage hidden beyond the displayed folder limit", async () => {
        files = Array.from({ length: 100 }, (_, i) => ({ filename: `tests/sub${i}/file.py` }));
        files.push({ filename: "zzz/unmapped.py" });
        pr.changed_files = files.length;
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**100 of 101");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    test("escapes folder paths in comment tables", async () => {
        files[0].filename = "tests/<script>|`/file.py";
        await sync();
        expect(body()).toContain("&lt;script&gt;&#124;&#96;");
        expect(body()).not.toContain("<script>");
    });

    test("reports API comment-write failures", async () => {
        octokit.rest.issues.createComment.mockRejectedValue(new Error("Cannot comment"));
        await expect(sync()).rejects.toThrow("Cannot comment");
    });

    test("queues review and PR updates using the bot token", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        const [events, handler] = app.on.mock.calls[0];
        expect(events).toEqual(expect.arrayContaining([
            "pull_request_review.submitted",
            "pull_request_review.dismissed",
            "pull_request.synchronize", "pull_request.edited",
        ]));
        await handler({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "submitted", review: { state: "approved" },
        } });
        expect(mockEnqueueAction).toHaveBeenCalledWith(
            expect.any(Function), "qualified approvals sonic-net/sonic-mgmt#42", app,
        );
        await mockEnqueueAction.mock.calls[0][0]();
        expect(mockOctokit).toHaveBeenCalledWith({ auth: "bot-token" });
        expect(body()).toContain(marker);
        expect(body()).not.toContain("## Reviewer assignment");
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    });

    test.each([
        "sonic-bmp", "sonic-buildimage", "sonic-dash-api", "sonic-dash-ha",
        "sonic-dbsyncd", "sonic-dhcp-relay", "sonic-dhcpmon", "sonic-fips",
        "sonic-genl-packet", "sonic-gnmi", "sonic-host-services", "sonic-linkmgrd",
        "sonic-linux-kernel", "sonic-mgmt", "sonic-mgmt-common", "sonic-mgmt-framework",
        "sonic-platform-common", "sonic-platform-daemons", "sonic-platform-vpp",
        "sonic-py-swsssdk", "sonic-redfish", "sonic-restapi", "sonic-sairedis",
        "sonic-snmpagent", "sonic-stp", "sonic-swss", "sonic-swss-common",
        "sonic-utilities", "sonic-wpa-supplicant", "sonic-ztp",
    ])("queues qualified approval processing for sonic-net/%s", async repo => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: `sonic-net/${repo}`, owner: { login: "sonic-net" }, name: repo },
            pull_request: pr, action: "submitted", review: { state: "approved" },
        } });
        expect(mockEnqueueAction).toHaveBeenCalledWith(
            expect.any(Function), `qualified approvals sonic-net/${repo}#42`, app,
        );
    });

    test("ignores comment-only reviews", async () => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt" },
            pull_request: pr, action: "submitted",
            review: { state: "commented" },
        } });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });

    test.each(["opened", "reopened", "ready_for_review", "synchronize", "edited", "submitted", "dismissed",
        "review_requested", "review_request_removed", "unlabeled"])(
        "ignores non-master %s events before queueing", async action => {
            pr.base.ref = "202511";
            const app = { on: jest.fn() };
            qualifiedApprovals.init(app);
            await app.on.mock.calls[0][1]({ payload: {
                repository: { full_name: "sonic-net/sonic-mgmt" },
                pull_request: pr, action, changes: { base: {} }, review: { state: "APPROVED" },
                label: { name: "Qualified-approval" },
            } });
            expect(mockEnqueueAction).not.toHaveBeenCalled();
            expect(mockGetGithubToken).not.toHaveBeenCalled();
        },
    );

    test.each(["changes_requested", "dismissed"])("updates only labels on %s reviews", async state => {
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice"), review("Alice", state.toUpperCase(), "head", 2)];
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: state === "dismissed" ? "dismissed" : "submitted",
            review: { state },
        } });
        await mockEnqueueAction.mock.calls[0][0]();
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalledWith(octokit.rest.repos.listCollaborators, expect.anything());
        noComment();
    });

    test("keeps the label when another approver still covers a dismissed approval", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        reviews = [review("Alice", "DISMISSED"), review("Bob", "APPROVED", "head", 2)];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        noComment();
    });

    test("silently removes qualification when an approver requests their own review again", async () => {
        pr.labels = [{ name: "Qualified-approval" }, { name: "unrelated" }];
        pr.requested_reviewers = [{ login: "ALICE" }];
        reviews = [review("Alice")];
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        const [events, handler] = app.on.mock.calls[0];
        expect(events).toContain("pull_request.review_requested");
        await handler({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "review_requested",
            requested_reviewer: { login: "Alice" }, sender: { login: "Alice" },
        } });
        await mockEnqueueAction.mock.calls[0][0]();
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, name: "Qualified-approval",
        });
        expect(pr.labels).toEqual([{ name: "unrelated" }]);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("an unrelated review request does not invalidate another user's approval", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        pr.requested_reviewers = [{ login: "Bob" }];
        reviews = [review("Alice")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).toHaveBeenCalledTimes(1);
        noComment();
    });

    test("a direct-child CODEOWNERS wildcard cannot qualify nested docs or submit an assessment", async () => {
        files = [{ filename: "docs/build-app/troubleshooting.md" }];
        source.content = Buffer.from("/other/: {}").toString("base64");
        reviews = [review("Docs")];
        pr.labels = [{ name: "Qualified-approval" }];
        const getContent = octokit.rest.repos.getContent.getMockImplementation();
        octokit.rest.repos.getContent.mockImplementation(async params => {
            if (params.path === ".github/CODEOWNERS") {
                return { data: {
                    type: "file", encoding: "base64",
                    content: Buffer.from("* @Default\ndocs/* @Docs").toString("base64"),
                } };
            }
            return getContent(params);
        });
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(body()).toContain("| No reviewer mapping | - | 0 | - |");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, name: "Qualified-approval",
        });
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
    });

    test("a re-request also excludes approval through CODEOWNERS", async () => {
        source.content = Buffer.from("/tests/: {}").toString("base64");
        const getContent = octokit.rest.repos.getContent.getMockImplementation();
        octokit.rest.repos.getContent.mockImplementation(async params => {
            if (params.path === ".github/CODEOWNERS") {
                return { data: { type: "file", encoding: "base64", content: Buffer.from("* @Alice").toString("base64") } };
            }
            return getContent(params);
        });
        pr.requested_reviewers = [{ login: "Alice" }];
        reviews = [review("Alice")];
        await sync();
        expect(body()).toContain("**0 of 1");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
    });

    test("team requests alone do not revoke individual approvals", async () => {
        pr.requested_teams = [{ slug: "owners" }];
        reviews = [review("Alice")];
        await sync();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
    });

    test("does not publish stale qualification if a review request arrives during evaluation", async () => {
        reviews = [review("Alice")];
        const current = { ...pr, requested_reviewers: [{ login: "Alice" }] };
        octokit.rest.pulls.get.mockResolvedValueOnce({ data: pr }).mockResolvedValueOnce({ data: current });
        await expect(sync()).rejects.toThrow("skipping stale summary");
        expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
        noComment();
    });

    test("another qualified approver can still cover a re-requested approval", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        pr.requested_reviewers = [{ login: "Alice" }];
        reviews = [review("Alice"), review("Bob", "APPROVED", "head", 2)];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
        noComment();
    });

    test("re-requesting one approver removes only their contribution to combined scores", async () => {
        source.content = Buffer.from("/tests/: {Alice: 0.2, Bob: 0.2}").toString("base64");
        pr.labels = [{ name: "Qualified-approval" }];
        pr.requested_reviewers = [{ login: "Alice" }];
        reviews = [review("Alice"), review("Bob", "APPROVED", "head", 2)];
        await sync();
        expect(body()).toContain("| Awaiting qualified approval | @Bob | 0.2 |");
        expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
        expect(mockSubmitMergeRiskAssessment).not.toHaveBeenCalled();
    });

    test("recalculates silently when an outstanding review request is removed", async () => {
        reviews = [review("Alice")];
        pr.requested_reviewers = [];
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        const [events, handler] = app.on.mock.calls[0];
        expect(events).toContain("pull_request.review_request_removed");
        await handler({ payload: {
            repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
            pull_request: pr, action: "review_request_removed",
        } });
        await mockEnqueueAction.mock.calls[0][0]();
        expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
        expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
        noComment();
    });

    test("a fresh approval counts after the re-review request clears", async () => {
        pr.labels = [{ name: "Qualified-approval" }];
        pr.requested_reviewers = [{ login: "Alice" }];
        reviews = [review("Alice")];
        await qualifiedApprovals.sync(octokit, "sonic-net", "sonic-mgmt", 42, false, console, false);
        expect(pr.labels).toEqual([]);
        pr.requested_reviewers = [];
        reviews.push(review("Alice", "APPROVED", "head", 2));
        await sync();
        expect(pr.labels).toEqual([{ name: "Qualified-approval" }]);
        expect(body()).toContain("**All changed folders have qualified approval.**");
    });

    test.each(["opened", "reopened", "ready_for_review", "synchronize", "edited"])(
        "assigns silently on %s events", async action => {
            const app = { on: jest.fn() };
            qualifiedApprovals.init(app);
            await app.on.mock.calls[0][1]({ payload: {
                repository: { full_name: "sonic-net/sonic-mgmt", owner: { login: "sonic-net" }, name: "sonic-mgmt" },
                pull_request: pr, action, changes: { base: {} },
            } });
            await mockEnqueueAction.mock.calls[0][0]();
            expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalled();
            noComment();
        },
    );

    test.each(["unlisted", "closed", "body-edit"])("ignores %s events", async kind => {
        const app = { on: jest.fn() };
        qualifiedApprovals.init(app);
        if (kind === "closed") pr.state = "closed";
        await app.on.mock.calls[0][1]({ payload: {
            repository: { full_name: kind === "unlisted" ? "someone/sonic-mgmt" : "sonic-net/sonic-mgmt" },
            pull_request: pr, action: kind === "body-edit" ? "edited" : "submitted",
            changes: { body: {} },
        } });
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });
});
