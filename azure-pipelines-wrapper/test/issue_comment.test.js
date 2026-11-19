const nock = require("nock");
const mockCreateComment = jest.fn();
const mockContextCreateComment = jest.fn();
const mockEnqueueAction = jest.fn();
const mockCheckCollaborator = jest.fn();
const mockGetGithubToken = jest.fn().mockResolvedValue("github-token");
const mockGetAdoAadToken = jest.fn();
const mockGetAzDevInfoFromCheckPayload = jest.fn();

jest.mock("@octokit/auth-token", () => ({ createTokenAuth: jest.fn() }));
jest.mock("@octokit/request", () => ({ request: jest.fn() }));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(() => ({
        rest: {
            repos: {
                checkCollaborator: mockCheckCollaborator,
            },
            issues: {
                createComment: mockCreateComment,
            },
        },
    })),
}));
jest.mock("@azure/core-amqp", () => ({ retry: jest.fn() }));
jest.mock("../azp", () => ({
    getAzDevInfoFromCheckPayload: mockGetAzDevInfoFromCheckPayload,
}));
jest.mock("../keyvault", () => ({
    getGithubToken: mockGetGithubToken,
}));
jest.mock("../adoauth", () => ({ getAdoAadToken: mockGetAdoAadToken }));
jest.mock("../check_run", () => ({}));
jest.mock("../action_queue", () => ({
    enqueueAction: mockEnqueueAction,
}));

const issueComment = require("../issue_comment");

describe("issue comment retry queue", () => {
    let handler;
    const app = {
        log: {
            info: jest.fn(),
            error: jest.fn(),
        },
        on: jest.fn((event, callback) => {
            handler = callback;
        }),
    };
    const context = {
        payload: {
            comment: {
                body: "/azpw retry",
                id: 1,
                user: {
                    login: "maintainer",
                },
            },
            issue: {
                number: 42,
                pull_request: {},
            },
            repository: {
                full_name: "sonic-net/sonic-buildimage",
                name: "sonic-buildimage",
                owner: {
                    login: "sonic-net",
                },
            },
        },
        octokit: {
            rest: {
                repos: {
                    checkCollaborator: jest.fn(() => {
                        throw new Error("App identity must not be used for collaborator lookup");
                    }),
                },
                issues: {
                    createComment: mockContextCreateComment,
                },
            },
        },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        context.payload.comment.body = "/azpw retry";
        context.payload.comment.user = { login: "maintainer" };
        delete context.payload.comment.author_association;
        mockCheckCollaborator.mockReset().mockResolvedValue({ status: 204 });
        issueComment.init(app);
    });

    describe("retry feedback for unavailable Azure DevOps builds", () => {
        const baseUrl = "https://dev.azure.com";
        const buildPath = "/test-org/test-project/_apis/build/builds/123";
        const timelinePath = `${buildPath}/timeline?api-version=7.1`;
        const stagePath = identifier => `${buildPath}/stages/${identifier}?api-version=7.1`;
        const retryBody = { state: 1, forceRetryAllJobs: false, retryDependencies: true };
        const failedStage = identifier => ({
            type: "Stage", identifier, name: identifier, result: "failed", state: "completed",
        });
        let handler;
        let context;

        beforeAll(() => nock.disableNetConnect());
        afterAll(() => nock.enableNetConnect());
        beforeEach(() => {
            jest.clearAllMocks();
            mockEnqueueAction.mockReset().mockReturnValue(Promise.resolve());
            mockCreateComment.mockReset().mockResolvedValue({});
            mockGetGithubToken.mockReset().mockResolvedValue("github-token");
            mockGetAdoAadToken.mockReset().mockResolvedValue("ado-token");
            mockGetAzDevInfoFromCheckPayload.mockReset().mockReturnValue({
                org: "test-org", projectId: "test-project", buildId: "123",
            });
            context = {
                payload: {
                    comment: { id: 1, body: "/azpw retry", user: { login: "contributor" }, author_association: "CONTRIBUTOR" },
                    issue: { number: 42, pull_request: {} },
                    repository: { full_name: "sonic-net/sonic-buildimage", name: "sonic-buildimage", owner: { login: "sonic-net" } },
                },
                octokit: {
                    rest: { issues: { createComment: mockContextCreateComment } },
                    pulls: { get: jest.fn().mockResolvedValue({ status: 200, data: { head: { sha: "head" } } }) },
                    checks: { listForRef: jest.fn().mockResolvedValue({
                        status: 200, data: { check_runs: [{ started_at: "2026-09-01T00:00:00Z" }] },
                    }) },
                },
            };
            issueComment.init({
                log: { info: jest.fn(), error: jest.fn() },
                on: jest.fn((event, callback) => { handler = callback; }),
            });
            jest.spyOn(console, "error").mockImplementation(() => {});
        });
        afterEach(() => {
            nock.cleanAll();
            jest.restoreAllMocks();
        });

        const run = async () => {
            await handler(context);
            await mockEnqueueAction.mock.calls[0][0]();
        };
        const lastBody = () => mockCreateComment.mock.calls[mockCreateComment.mock.calls.length - 1][0].body;

        test.each([404, 410])("explains an unavailable build after timeline HTTP %s, without retrying", async status => {
            const request = nock(baseUrl).get(timelinePath).reply(status, { message: "Build not found" });
            await run();
            expect(request.isDone()).toBe(true);
            expect(mockCreateComment).toHaveBeenCalledTimes(2);
            expect(lastBody()).toContain("Cannot retry Azure DevOps build 123");
            expect(lastBody()).toContain("2-week retention policy (14 days after completion)");
            expect(lastBody()).toContain("cannot recreate a deleted build");
            expect(lastBody()).toContain("close and reopen the PR or push a new commit");
            expect(lastBody().split("\n\n")).toHaveLength(4);
            expect(mockContextCreateComment).not.toHaveBeenCalled();
            expect(require("@octokit/rest").Octokit).toHaveBeenCalledWith({ auth: "github-token" });
        });

        test.each(["/azpw run", "/azurepipelineswrapper retry", "/azurepipelineswrapper run"])(
            "reports expired builds for the %s alias", async command => {
                context.payload.comment.body = command;
                nock(baseUrl).get(timelinePath).reply(404);
                await run();
                expect(lastBody()).toContain("cannot recreate a deleted build");
                expect(mockContextCreateComment).not.toHaveBeenCalled();
            },
        );

        test.each([401, 403, 429, 500])("reports timeline HTTP %s without claiming the build expired", async status => {
            nock(baseUrl).get(timelinePath).reply(status, { message: "Service error" });
            await expect(run()).rejects.toThrow(`ADO request failed with ${status}`);
            expect(lastBody()).toContain(`(HTTP ${status})`);
            expect(lastBody()).toContain("No stages were retried");
            expect(lastBody()).not.toContain("retention");
            expect(mockContextCreateComment).not.toHaveBeenCalled();
        });

        test("reports a timeline network failure and preserves the queue error", async () => {
            nock(baseUrl).get(timelinePath).replyWithError("Connection lost");
            await expect(run()).rejects.toThrow("Connection lost");
            expect(lastBody()).toContain("timeline could not be read");
            expect(lastBody()).toContain("No stages were retried");
            expect(lastBody()).not.toContain("retention");
        });

        test("reports invalid timeline JSON instead of silently returning", async () => {
            nock(baseUrl).get(timelinePath).reply(200, "not JSON");
            await expect(run()).rejects.toThrow();
            expect(lastBody()).toContain("timeline could not be read");
            expect(lastBody()).toContain("No stages were retried");
        });

        test.each([null, {}, { records: {} }])("reports malformed timeline records: %p", async timeline => {
            nock(baseUrl).get(timelinePath).reply(200, JSON.stringify(timeline));
            await expect(run()).rejects.toThrow("Invalid timeline records for build 123");
            expect(lastBody()).toContain("without a valid records list");
            expect(lastBody()).not.toContain("retention");
        });

        test("does not mistake an empty valid timeline for a deleted build", async () => {
            nock(baseUrl).get(timelinePath).reply(200, { records: [] });
            await run();
            expect(lastBody()).toContain("No failed(or canceled) stages or jobs");
            expect(lastBody()).not.toContain("retention");
        });

        test("still retries an old build if it is available", async () => {
            nock(baseUrl).get(timelinePath).reply(200, { records: [failedStage("Build")] });
            const retry = nock(baseUrl).patch(stagePath("Build"), retryBody).reply(200, {});
            await run();
            expect(retry.isDone()).toBe(true);
            expect(lastBody()).toContain("Stage **Build**");
            expect(lastBody()).not.toContain("retention");
        });

        test.each([404, 410])("stops further retries if the build disappears during a stage retry with HTTP %s", async status => {
            nock(baseUrl).get(timelinePath).reply(200, { records: [failedStage("Build"), failedStage("Test")] });
            const retry = nock(baseUrl).patch(stagePath("Build"), retryBody).reply(status);
            const unexpectedRetry = nock(baseUrl).patch(stagePath("Test"), retryBody).reply(200);
            await run();
            expect(retry.isDone()).toBe(true);
            expect(unexpectedRetry.isDone()).toBe(false);
            expect(lastBody()).toContain("2-week retention policy (14 days after completion)");
            expect(lastBody()).toContain("Stage **Build** was not retried");
            expect(lastBody()).toContain("no further stages will be attempted");
            expect(mockContextCreateComment).not.toHaveBeenCalled();
        });

        test("surfaces failure to post the unavailable-build comment without using the app identity", async () => {
            nock(baseUrl).get(timelinePath).reply(404);
            mockCreateComment.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Cannot post bot comment"));
            await expect(run()).rejects.toThrow("Cannot post bot comment");
            expect(mockContextCreateComment).not.toHaveBeenCalled();
        });
    });

    test("reports a full queue without posting retry success", async () => {
        mockEnqueueAction.mockImplementation(() => {
            throw new Error("Action queue is full (100 pending)");
        });

        await handler(context);

        expect(mockCreateComment).toHaveBeenCalledTimes(1);
        expect(mockCreateComment.mock.calls[0][0].body)
            .toBe("⚠️ Unable to queue the retry because the action queue is full. Please try again later.");
    });

    test("does not post retry success before the queued action starts", async () => {
        mockEnqueueAction.mockReturnValue(Promise.resolve());

        await handler(context);

        expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        expect(mockCreateComment).not.toHaveBeenCalled();
    });

    test.each(["read", "triage", "write", "maintain", "admin"])(
        "allows a confirmed collaborator regardless of their %s role",
        async (role) => {
            mockEnqueueAction.mockReturnValue(Promise.resolve());
            context.payload.comment.user.login = `${role}-collaborator`;

            await handler(context);

            expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
            expect(mockCheckCollaborator).toHaveBeenCalledWith({
                owner: "sonic-net", repo: "sonic-buildimage", username: `${role}-collaborator`,
            });
            expect(mockContextCreateComment).not.toHaveBeenCalled();
        }
    );

    test.each([
        "/azpw retry", "/azpw run", "/azurepipelineswrapper retry", "/azurepipelineswrapper run",
    ])("allows %s from a confirmed collaborator", async command => {
        context.payload.comment.body = command;
        mockEnqueueAction.mockReturnValue(Promise.resolve());
        await handler(context);
        expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        expect(mockContextCreateComment).not.toHaveBeenCalled();
    });

    test("allows an admin with MEMBER association using bot-authenticated membership verification", async () => {
        context.payload.comment.user.login = "yijingyan2";
        context.payload.comment.author_association = "MEMBER";
        await handler(context);
        expect(mockCheckCollaborator).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-buildimage", username: "yijingyan2",
        });
        expect(context.octokit.rest.repos.checkCollaborator).not.toHaveBeenCalled();
        expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        expect(mockCreateComment).not.toHaveBeenCalled();
    });

    test.each([
        "/azpw retry", "/azpw run", "/azurepipelineswrapper retry", "/azurepipelineswrapper run",
    ])("allows %s from a GitHub-recognized contributor without collaborator membership", async command => {
        context.payload.comment.body = command;
        context.payload.comment.author_association = "CONTRIBUTOR";
        mockEnqueueAction.mockReturnValue(Promise.resolve());
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        await handler(context);
        expect(mockCheckCollaborator).not.toHaveBeenCalled();
        expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        expect(mockContextCreateComment).not.toHaveBeenCalled();
    });

    test.each(["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MEMBER", "COLLABORATOR", "OWNER", undefined])(
        "requires collaborator verification when author association is %s", async association => {
            context.payload.comment.author_association = association;
            mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
            await handler(context);
            expect(mockCheckCollaborator).toHaveBeenCalledTimes(1);
            expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
            expect(mockEnqueueAction).not.toHaveBeenCalled();
            expect(mockCreateComment).toHaveBeenCalled();
            expect(mockContextCreateComment).not.toHaveBeenCalled();
        },
    );

    test("does not grant contributor access based on comment text or issue author association", async () => {
        context.payload.comment.body = "/azpw retry CONTRIBUTOR";
        context.payload.issue.author_association = "CONTRIBUTOR";
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        try {
            await handler(context);
            expect(mockCheckCollaborator).toHaveBeenCalledTimes(1);
            expect(mockEnqueueAction).not.toHaveBeenCalled();
            expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        } finally {
            delete context.payload.issue.author_association;
        }
    });

    test.each([
        "/azpw retry", "/azpw run", "/azurepipelineswrapper retry", "/azurepipelineswrapper run",
    ])("denies %s from a non-collaborator", async command => {
        context.payload.comment.body = command;
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

        await handler(context);

        expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(mockContextCreateComment).not.toHaveBeenCalled();
        expect(app.log.info).toHaveBeenCalledWith(expect.stringContaining("non-collaborator"));
        expect(require("@octokit/rest").Octokit).toHaveBeenCalledWith({ auth: "github-token" });
        expect(mockCreateComment).toHaveBeenCalledWith({
            owner: "sonic-net",
            repo: "sonic-buildimage",
            issue_number: 42,
            body: "⚠️ Retry not queued. Only repository collaborators and GitHub-recognized contributors with previous commits to this repository can retry Azure Pipelines jobs.",
        });
    });

    test.each([401, 403, 429, 500, undefined])("reports verification failure when collaborator lookup fails with %s", async status => {
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("GitHub unavailable"), { status }));

        await handler(context);

        expect(app.log.error).toHaveBeenCalledTimes(1);
        expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(mockContextCreateComment).not.toHaveBeenCalled();
        expect(mockCreateComment).toHaveBeenCalledWith({
            owner: "sonic-net",
            repo: "sonic-buildimage",
            issue_number: 42,
            body: "⚠️ Retry not queued because the bot could not verify your repository access. This does not mean you lack permission. Please try again later; if this persists, ask a repository maintainer to check the bot's GitHub access and authorization logs.",
        });
    });

    test("denies a retry without a comment author before checking membership", async () => {
        context.payload.comment.user = null;
        context.payload.comment.author_association = "CONTRIBUTOR";
        await handler(context);
        expect(mockCheckCollaborator).not.toHaveBeenCalled();
        expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(app.log.error).toHaveBeenCalledWith(expect.stringContaining("without a comment author"));
        expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("could not verify your repository access"),
        }));
        expect(mockContextCreateComment).not.toHaveBeenCalled();
    });

    test.each([200, 202, undefined])("denies an unexpected collaborator response status %s", async status => {
        mockCheckCollaborator.mockResolvedValue({ status });
        await handler(context);
        expect(mockGetGithubToken).toHaveBeenCalledTimes(1);
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(app.log.error).toHaveBeenCalledWith(expect.stringContaining("Unexpected collaborator lookup status"));
        expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.stringContaining("could not verify your repository access"),
        }));
        expect(mockContextCreateComment).not.toHaveBeenCalled();
    });

    test("does not fall back to app comments when the bot token cannot be loaded", async () => {
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        mockGetGithubToken.mockRejectedValueOnce(new Error("Bot token unavailable"));
        await expect(handler(context)).rejects.toThrow("Bot token unavailable");
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockContextCreateComment).not.toHaveBeenCalled();
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });

    test("surfaces bot comment failures without queueing or falling back to app comments", async () => {
        mockCheckCollaborator.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        mockCreateComment.mockRejectedValueOnce(new Error("Cannot post bot comment"));
        await expect(handler(context)).rejects.toThrow("Cannot post bot comment");
        expect(mockContextCreateComment).not.toHaveBeenCalled();
        expect(mockEnqueueAction).not.toHaveBeenCalled();
    });
});
