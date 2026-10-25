const mockEnqueueAction = jest.fn();
const mockRunBashAction = jest.fn();
const mockGetGithubToken = jest.fn();
const mockGetSecret = jest.fn();
const mockPaginate = jest.fn();
const mockRemoveLabel = jest.fn();
const mockCreateComment = jest.fn();
jest.mock("../action_queue", () => ({
    enqueueAction: mockEnqueueAction,
    runBashAction: mockRunBashAction,
}));
jest.mock("../keyvault", () => ({
    getGithubToken: mockGetGithubToken,
    getSecretFromCache: mockGetSecret,
}));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(() => ({
        rest: { issues: {
            listLabelsOnIssue: jest.fn(),
            removeLabel: mockRemoveLabel,
            createComment: mockCreateComment,
        } },
        paginate: mockPaginate,
    })),
}));
const autoCherrypick = require("../auto_cherrypick");

describe("cherry-pick tested-label prerequisite", () => {
    let handler;
    let payload;
    let app;
    const request = "Request for 202505 Branch";
    const tested = "Tested for 202505 Branch";
    const approved = "Approved for 202505 Branch";

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetGithubToken.mockResolvedValue("github-token");
        mockGetSecret.mockResolvedValue("https://example.com/script.sh");
        mockRunBashAction.mockResolvedValue({ status: 0 });
        mockPaginate.mockResolvedValue([{ name: request }, { name: tested }]);
        mockRemoveLabel.mockReset();
        mockRemoveLabel.mockResolvedValue({});
        mockCreateComment.mockReset();
        mockCreateComment.mockResolvedValue({});
        app = {
            on: jest.fn((events, callback) => { handler = callback; }),
            log: { info: jest.fn(), error: jest.fn() },
        };
        autoCherrypick.init(app);
        payload = {
            action: "labeled", number: 42, label: { name: request },
            sender: { login: "maintainer" },
            repository: { full_name: "sonic-net/sonic-buildimage" },
            pull_request: {
                merged: false, labels: [{ name: request }, { name: tested }],
                user: { login: "contributor" }, base: { ref: "master" },
                html_url: "https://github.com/sonic-net/sonic-buildimage/pull/42",
            },
        };
    });

    async function execute() {
        await handler({ payload });
        await mockEnqueueAction.mock.calls[0][0]();
    }

    test("does not process a request when the current tested label is absent", async () => {
        mockPaginate.mockResolvedValue([{ name: request }]);
        await execute();
        expect(mockRunBashAction).not.toHaveBeenCalled();
        expect(app.log.info).toHaveBeenCalledWith(expect.stringContaining("Skip request"));
    });

    test("ignores stale request-label events after the request was removed", async () => {
        mockPaginate.mockResolvedValue([{ name: tested }]);
        await execute();
        expect(mockRunBashAction).not.toHaveBeenCalled();
    });

    test("processes a request only with its matching current tested label", async () => {
        mockPaginate.mockResolvedValue([{ name: request }, { name: tested.toLowerCase() }]);
        await execute();
        expect(mockRunBashAction).toHaveBeenCalledWith(expect.arrayContaining([
            `ACTION_LABEL="${request}"`, "GH_TOKEN=github-token",
        ]));
    });

    test("filters invalid requests from fresh labels on synchronize", async () => {
        payload.action = "synchronize";
        payload.pull_request.labels.push({ name: "Request for msft-202512 Branch" });
        mockPaginate.mockResolvedValue([
            { name: request },
            { name: "Request for msft-202512 Branch" },
            { name: "Tested for msft-202512 Branch" },
        ]);
        await execute();
        const params = mockRunBashAction.mock.calls[0][0];
        expect(params).toContain('PR_LABELS="Request for msft-202512 Branch,Tested for msft-202512 Branch"');
    });

    test("leaves new requests on synchronize to their own label events", async () => {
        payload.action = "synchronize";
        mockPaginate.mockResolvedValue([
            { name: request }, { name: tested },
            { name: "Request for msft-202512 Branch" },
            { name: "Tested for msft-202512 Branch" },
        ]);
        await execute();
        const params = mockRunBashAction.mock.calls[0][0];
        expect(params).toContain(`PR_LABELS="${request},${tested},Tested for msft-202512 Branch"`);
    });

    test("processes an approval with a matching current request", async () => {
        payload.label.name = approved;
        mockPaginate.mockResolvedValue([
            { name: approved }, { name: request.toLowerCase() }, { name: tested },
        ]);
        await execute();
        expect(mockRemoveLabel).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalledWith(expect.arrayContaining([
            'ACTION_LABEL="Approved for 202505 Branch"', 'ACTION_SENDER="maintainer"',
        ]));
    });

    test.each([
        ["Approved for 202505 Branch", []],
        ["Approved for 202505 Branch", ["Request for 202511 Branch", tested]],
        ["Approved for msft-202512 Branch", ["Request for 202512 Branch"]],
        ["APPROVED FOR MSFT-202512 BRANCH", []],
    ])("removes %s without its matching request and skips cherry-pick", async (approval, otherLabels) => {
        payload.label.name = approval;
        mockPaginate.mockResolvedValue([approval, ...otherLabels].map(name => ({ name })));
        await execute();
        expect(mockRemoveLabel).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-buildimage", issue_number: 42, name: approval,
        });
        const branch = approval.match(/^Approved for (.+) Branch$/i)[1].toLowerCase();
        expect(mockCreateComment).toHaveBeenCalledTimes(1);
        expect(mockCreateComment).toHaveBeenCalledWith({
            owner: "sonic-net", repo: "sonic-buildimage", issue_number: 42,
            body: `Removed \`${approval}\` because the matching \`Request for ${branch} Branch\` label is missing. Please ensure the matching request label is present before adding the approval again.\n\n<div align="right"><sub>---Powered by SONiC BuildBot</sub></div>`,
        });
        expect(mockRemoveLabel.mock.invocationCallOrder[0])
            .toBeLessThan(mockCreateComment.mock.invocationCallOrder[0]);
        expect(mockRunBashAction).not.toHaveBeenCalled();
        expect(mockGetSecret).not.toHaveBeenCalled();
    });

    test("accepts a matching internal-branch request", async () => {
        payload.label.name = "Approved for msft-202512 Branch";
        mockPaginate.mockResolvedValue([
            { name: payload.label.name }, { name: "request for msft-202512 branch" },
        ]);
        await execute();
        expect(mockRemoveLabel).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalled();
    });

    test("ignores stale approval events even if the payload still has the request", async () => {
        payload.label.name = approved;
        await execute();
        expect(mockRemoveLabel).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockRunBashAction).not.toHaveBeenCalled();
    });

    test.each(["synchronize", "closed"])("leaves existing approvals untouched on %s", async action => {
        payload.action = action;
        payload.pull_request.merged = true;
        payload.pull_request.labels = [{ name: approved }];
        mockPaginate.mockResolvedValue([{ name: approved }]);
        await execute();
        expect(mockRemoveLabel).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalledWith(expect.arrayContaining([
            `PR_LABELS="${approved}"`,
        ]));
    });

    test("does not remove unrelated existing approvals when a new approval is added", async () => {
        payload.label.name = approved;
        mockPaginate.mockResolvedValue([
            { name: approved }, { name: request },
            { name: "Approved for 202511 Branch" },
        ]);
        await execute();
        expect(mockRemoveLabel).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalled();
    });

    test("fails closed if removing an invalid approval fails", async () => {
        payload.label.name = approved;
        mockPaginate.mockResolvedValue([{ name: approved }]);
        mockRemoveLabel.mockRejectedValue(new Error("Removal failed"));
        await expect(execute()).rejects.toThrow("Removal failed");
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockRunBashAction).not.toHaveBeenCalled();
    });

    test("surfaces comment failures without proceeding to cherry-pick", async () => {
        payload.label.name = approved;
        mockPaginate.mockResolvedValue([{ name: approved }]);
        mockCreateComment.mockRejectedValue(new Error("Comment failed"));
        await expect(execute()).rejects.toThrow("Comment failed");
        expect(mockRemoveLabel).toHaveBeenCalled();
        expect(mockRunBashAction).not.toHaveBeenCalled();
    });

    test("preserves merged-PR processing", async () => {
        payload.action = "closed";
        payload.pull_request.merged = true;
        await execute();
        expect(mockPaginate).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalledWith(expect.arrayContaining([
            "ACTION=closed", "PR_MERGED=true",
        ]));
    });

    test("fails closed when current-label lookup fails", async () => {
        mockPaginate.mockRejectedValue(new Error("GitHub unavailable"));
        await handler({ payload });
        await expect(mockEnqueueAction.mock.calls[0][0]()).rejects.toThrow("GitHub unavailable");
        expect(mockRunBashAction).not.toHaveBeenCalled();
    });

    test("does not subscribe to description updates", () => {
        expect(app.on.mock.calls[0][0]).not.toContain("pull_request.edited");
    });
});
