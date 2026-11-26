const nock = require("nock");
const https = require("https");
const { EventEmitter } = require("events");

const mockGetToken = jest.fn();
jest.mock("@azure/identity", () => ({
    ManagedIdentityCredential: jest.fn(function () { return { getToken: mockGetToken }; }),
}));
const { ManagedIdentityCredential } = require("@azure/identity");
const { submit, submitBatch } = require("../merge_risk_assessment");

const baseUrl = "https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net";
const marker = "<!-- sonic-merge-risk-assessment:head -->";

describe("merge risk assessment", () => {
    const originalClientId = process.env.ADO_MI_CLIENT_ID;
    let octokit;
    let pr;
    let comments;
    let log;

    beforeAll(() => nock.disableNetConnect());
    afterAll(() => {
        nock.enableNetConnect();
        if (originalClientId === undefined) delete process.env.ADO_MI_CLIENT_ID;
        else process.env.ADO_MI_CLIENT_ID = originalClientId;
    });
    beforeEach(() => {
        process.env.ADO_MI_CLIENT_ID = "configured-managed-identity";
        mockGetToken.mockReset().mockResolvedValue({ token: "entra-token" });
        pr = { number: 42, state: "open", head: { sha: "head" }, base: { sha: "base", ref: "master" } };
        comments = [];
        log = { info: jest.fn() };
        octokit = {
            rest: {
                pulls: { get: jest.fn(async () => ({ data: pr })) },
                issues: {
                    listComments: jest.fn(),
                    createComment: jest.fn(async ({ body }) => {
                        comments.push({ user: { login: "mssonicbld" }, body });
                    }),
                },
            },
            paginate: jest.fn(async () => comments),
        };
    });
    afterEach(() => {
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    const run = () => submit(octokit, "sonic-net", "sonic-mgmt", pr, log);
    const task = status => nock(baseUrl, {
        reqheaders: {
            authorization: "Bearer entra-token",
            "content-type": "application/json",
        },
    }).post("/v1/task-plans/github-app", {
        type: "MERGE_RISK_ASSESSMENT",
        pbi_id: "40516754",
        description: `Assess merge risk for https://github.com/sonic-net/sonic-mgmt/pull/42 at head commit ${pr.head.sha}.`,
    }).reply(status);

    const candidates = () => [
        { owner: "sonic-net", repo: "sonic-mgmt", pr },
        { owner: "sonic-net", repo: "sonic-swss", pr: { ...pr, number: 43 } },
    ];
    const prepareBatch = () => {
        octokit.rest.pulls.get.mockImplementation(async ({ pull_number }) => ({
            data: { ...pr, number: pull_number },
        }));
        octokit.paginate.mockImplementation(async (method, { issue_number }) => issue_number === 42 ? comments : []);
    };

    test("submits multiple PRs in exactly one task with every URL and head, then records individual receipts", async () => {
        prepareBatch();
        const request = nock(baseUrl).post("/v1/task-plans/github-app", {
            type: "MERGE_RISK_ASSESSMENT",
            pbi_id: "40516754",
            description: "Assess merge risk for https://github.com/sonic-net/sonic-mgmt/pull/42 at head commit head.\n" +
                "Assess merge risk for https://github.com/sonic-net/sonic-swss/pull/43 at head commit head.",
        }).reply(202);
        await submitBatch(octokit, candidates(), log);
        expect(request.isDone()).toBe(true);
        expect(mockGetToken).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-swss", issue_number: 43,
            body: expect.stringContaining(marker),
        });
    });

    test("omits already submitted heads from the combined task", async () => {
        prepareBatch();
        comments.push({ user: { login: "mssonicbld" }, body: marker });
        const request = nock(baseUrl).post("/v1/task-plans/github-app", body =>
            body.description === "Assess merge risk for https://github.com/sonic-net/sonic-swss/pull/43 at head commit head.",
        ).reply(202);
        await submitBatch(octokit, candidates(), log);
        expect(request.isDone()).toBe(true);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    test("does not authenticate or submit an empty or fully receipted batch", async () => {
        await submitBatch(octokit, [], log);
        comments.push({ user: { login: "mssonicbld" }, body: marker });
        await submitBatch(octokit, [candidates()[0]], log);
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("deduplicates repeated candidates within a batch", async () => {
        const request = task(202);
        await submitBatch(octokit, [candidates()[0], candidates()[0]], log);
        expect(request.isDone()).toBe(true);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    test.each([7, 8, 15])("limits %s PRs to seven per run and carries overflow into later batches", async count => {
        const all = Array.from({ length: count }, (_, index) => ({
            owner: "sonic-net", repo: "sonic-mgmt",
            pr: { ...pr, number: 42 + index, head: { sha: `head-${index}` } },
        }));
        const savedReceipts = new Map();
        octokit.rest.pulls.get.mockImplementation(async ({ pull_number }) => ({
            data: all.find(candidate => candidate.pr.number === pull_number).pr,
        }));
        octokit.paginate.mockImplementation(async (method, { issue_number }) =>
            savedReceipts.get(issue_number) || [],
        );
        octokit.rest.issues.createComment.mockImplementation(async ({ issue_number, body }) => {
            savedReceipts.set(issue_number, [{ user: { login: "mssonicbld" }, body }]);
        });

        for (let offset = 0; offset < count; offset += 7) {
            const batch = all.slice(offset, offset + 7);
            const request = nock(baseUrl).post("/v1/task-plans/github-app", {
                type: "MERGE_RISK_ASSESSMENT",
                pbi_id: "40516754",
                description: batch.map(({ owner, repo, pr: candidate }) =>
                    `Assess merge risk for https://github.com/${owner}/${repo}/pull/${candidate.number} at head commit ${candidate.head.sha}.`,
                ).join("\n"),
            }).reply(202);
            await submitBatch(octokit, all, log);
            expect(request.isDone()).toBe(true);
            expect(mockGetToken).toHaveBeenCalledTimes(offset / 7 + 1);
            expect([...savedReceipts.keys()]).toEqual(all.slice(0, offset + 7).map(candidate => candidate.pr.number));
            expect(octokit.rest.issues.createComment.mock.calls.slice(offset).map(([issue]) => issue.issue_number))
                .toEqual(batch.map(candidate => candidate.pr.number));
        }

        await submitBatch(octokit, all, log);
        expect(mockGetToken).toHaveBeenCalledTimes(Math.ceil(count / 7));
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(count);
    });

    test("already receipted PRs and duplicate candidates do not consume batch slots", async () => {
        const all = Array.from({ length: 9 }, (_, index) => ({
            owner: "sonic-net", repo: "sonic-mgmt", pr: { ...pr, number: 42 + index },
        }));
        prepareBatch();
        comments.push({ user: { login: "mssonicbld" }, body: marker });
        const batch = all.slice(1, 8);
        const request = nock(baseUrl).post("/v1/task-plans/github-app", {
            type: "MERGE_RISK_ASSESSMENT",
            pbi_id: "40516754",
            description: batch.map(({ owner, repo, pr: candidate }) =>
                `Assess merge risk for https://github.com/${owner}/${repo}/pull/${candidate.number} at head commit ${candidate.head.sha}.`,
            ).join("\n"),
        }).reply(202);
        await submitBatch(octokit, [all[0], all[1], all[1], ...all.slice(2)], log);
        expect(request.isDone()).toBe(true);
        expect(mockGetToken).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment.mock.calls.map(([issue]) => issue.issue_number))
            .toEqual(batch.map(candidate => candidate.pr.number));
        expect(octokit.rest.pulls.get).not.toHaveBeenCalledWith(expect.objectContaining({ pull_number: 50 }));
    });

    test("does not submit any batch entries if final freshness validation fails", async () => {
        prepareBatch();
        octokit.rest.pulls.get.mockResolvedValueOnce({ data: pr })
            .mockResolvedValueOnce({ data: { ...pr, state: "closed" } });
        await expect(submitBatch(octokit, candidates(), log)).rejects.toThrow("skipping stale request");
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("does not write any receipts for a rejected combined task", async () => {
        prepareBatch();
        nock(baseUrl).post("/v1/task-plans/github-app").reply(503);
        await expect(submitBatch(octokit, candidates(), log)).rejects.toThrow("HTTP 503");
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("attempts every receipt and waits for all writes when one fails", async () => {
        prepareBatch();
        nock(baseUrl).post("/v1/task-plans/github-app").reply(202);
        let finish;
        octokit.rest.issues.createComment
            .mockRejectedValueOnce(new Error("Cannot save first receipt"))
            .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        let completed = false;
        const submission = submitBatch(octokit, candidates(), log);
        const assertion = expect(submission).rejects.toThrow("Cannot save first receipt");
        submission.then(() => { completed = true; }, () => { completed = true; });
        while (octokit.rest.issues.createComment.mock.calls.length < 2) {
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(completed).toBe(false);
        finish();
        await assertion;
    });

    test.each([200, 201, 202, 204])("submits the exact model-free GitHub-app payload and records a receipt after HTTP %s", async status => {
        const request = task(status);
        await run();
        expect(request.isDone()).toBe(true);
        expect(ManagedIdentityCredential).toHaveBeenCalledWith({
            clientId: "configured-managed-identity",
        });
        expect(mockGetToken).toHaveBeenCalledWith("api://sonic-testbed-tools-prod/.default");
        expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listComments, {
            owner: "sonic-net", repo: "sonic-mgmt", issue_number: 42, per_page: 100,
        });
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toContain(marker);
        expect(comments[0].body).toContain("not completion or approval to merge");
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("submitted head head"));
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("PBI 40516754"));
    });

    test.each([undefined, "", "   "])("requires an explicit managed identity client ID: %p", async clientId => {
        if (clientId === undefined) delete process.env.ADO_MI_CLIENT_ID;
        else process.env.ADO_MI_CLIENT_ID = clientId;
        const request = jest.spyOn(https, "request");
        await expect(run()).rejects.toThrow("Set ADO_MI_CLIENT_ID");
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
    });

    test("deduplicates across calls and client instances using persisted bot receipts", async () => {
        const request = task(202);
        await run();
        await submit({ ...octokit }, "sonic-net", "sonic-mgmt", pr, log);
        expect(request.isDone()).toBe(true);
        expect(mockGetToken).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    test("submits again for a new head commit", async () => {
        const first = task(202);
        await run();
        pr = { ...pr, head: { sha: "new-head" } };
        const second = task(202);
        await run();
        expect(first.isDone() && second.isDone()).toBe(true);
        expect(comments).toHaveLength(2);
        expect(comments[1].body).toContain("<!-- sonic-merge-risk-assessment:new-head -->");
    });

    test("accepts a case-insensitive bot login but not other authors or quoted markers", async () => {
        comments.push(
            { user: { login: "someone" }, body: marker },
            { user: { login: "mssonicbld" }, body: `> ${marker}` },
        );
        const request = task(202);
        await run();
        expect(request.isDone()).toBe(true);
        comments[2].user.login = "MSSonicBld";
        await run();
        expect(mockGetToken).toHaveBeenCalledTimes(1);
    });

    test.each([301, 400, 401, 403, 422, 429, 500])("surfaces HTTP %s without recording success", async status => {
        const request = task(status);
        await expect(run()).rejects.toThrow(`HTTP ${status}`);
        expect(request.isDone()).toBe(true);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
    });

    test("includes validation details in HTTP 422 errors without recording or retrying submission", async () => {
        const detail = { detail: [{ loc: ["body", "pbi_id"], msg: "Field required", type: "missing" }] };
        const request = nock(baseUrl).post("/v1/task-plans/github-app").reply(422, detail);
        await expect(run()).rejects.toThrow(`HTTP 422: ${JSON.stringify(detail)}`);
        expect(request.isDone()).toBe(true);
        expect(mockGetToken).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
    });

    test("reports empty error responses explicitly", async () => {
        const request = task(422);
        await expect(run()).rejects.toThrow("HTTP 422 (empty response body)");
        expect(request.isDone()).toBe(true);
    });

    test("redacts the access token if the server echoes it in an error response", async () => {
        nock(baseUrl).post("/v1/task-plans/github-app").reply(422, "Invalid request\nentra-token");
        await expect(run()).rejects.toThrow("HTTP 422: Invalid request [REDACTED]");
    });

    test("bounds error response details at 8192 bytes", async () => {
        nock(baseUrl).post("/v1/task-plans/github-app").reply(422, "x".repeat(8192) + "not-captured");
        await expect(run()).rejects.toThrow(
            `HTTP 422: ${"x".repeat(8192)} [response truncated at 8192 bytes]`,
        );
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("accumulates chunked validation responses within the size limit", async () => {
        const response = new EventEmitter();
        response.statusCode = 422;
        response.resume = jest.fn(() => {
            response.emit("data", Buffer.from("Invalid "));
            response.emit("data", Buffer.from("payload"));
            response.emit("end");
        });
        const request = new EventEmitter();
        request.setTimeout = jest.fn();
        request.end = jest.fn();
        jest.spyOn(https, "request").mockImplementation((url, options, callback) => {
            callback(response);
            return request;
        });
        await expect(run()).rejects.toThrow("HTTP 422: Invalid payload");
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("retries on a later event after a rejected request", async () => {
        const rejected = task(503);
        await expect(run()).rejects.toThrow("HTTP 503");
        const accepted = task(202);
        await run();
        expect(rejected.isDone() && accepted.isDone()).toBe(true);
        expect(comments).toHaveLength(1);
    });

    test("surfaces authentication failures", async () => {
        mockGetToken.mockRejectedValue(new Error("Identity unavailable"));
        await expect(run()).rejects.toThrow("Identity unavailable");
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test.each([null, {}, { token: "" }])("rejects a missing access token: %p", async token => {
        mockGetToken.mockResolvedValue(token);
        await expect(run()).rejects.toThrow("returned no access token");
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("surfaces network failures", async () => {
        nock(baseUrl).post("/v1/task-plans/github-app").replyWithError("Connection lost");
        await expect(run()).rejects.toThrow("Connection lost");
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("destroys timed-out requests and surfaces the unknown submission state", async () => {
        const request = new EventEmitter();
        let timeout;
        request.setTimeout = jest.fn((milliseconds, callback) => { timeout = callback; });
        request.destroy = jest.fn(error => request.emit("error", error));
        request.end = jest.fn(() => timeout());
        jest.spyOn(https, "request").mockReturnValue(request);
        await expect(run()).rejects.toThrow("timed out; submission status is unknown");
        expect(request.setTimeout).toHaveBeenCalledWith(60000, expect.any(Function));
        expect(request.destroy).toHaveBeenCalledTimes(1);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test.each(["head", "base", "target", "review request", "closed"])("does not submit if PR %s changes during receipt lookup", async change => {
        const current = { ...pr, head: { ...pr.head }, base: { ...pr.base } };
        if (change === "closed") current.state = "closed";
        else if (change === "target") current.base.ref = "202511";
        else if (change === "review request") current.requested_reviewers = [{ login: "Alice" }];
        else current[change].sha = "new-sha";
        octokit.rest.pulls.get.mockResolvedValue({ data: current });
        await expect(run()).rejects.toThrow("skipping stale request");
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test("does not submit when receipt lookup fails", async () => {
        octokit.paginate.mockRejectedValue(new Error("Cannot list comments"));
        await expect(run()).rejects.toThrow("Cannot list comments");
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("surfaces receipt-write failures after logging the accepted submission", async () => {
        const request = task(202);
        octokit.rest.issues.createComment.mockRejectedValue(new Error("Cannot save receipt"));
        await expect(run()).rejects.toThrow("Cannot save receipt");
        expect(request.isDone()).toBe(true);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("submitted head head"));
    });
});
