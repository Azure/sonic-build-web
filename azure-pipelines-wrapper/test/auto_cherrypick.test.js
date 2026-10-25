const mockEnqueueAction = jest.fn();
const mockRunBashAction = jest.fn();
const mockGetGithubToken = jest.fn();
const mockGetSecret = jest.fn();
const mockPaginate = jest.fn();
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
        rest: { issues: { listLabelsOnIssue: jest.fn() } },
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

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetGithubToken.mockResolvedValue("github-token");
        mockGetSecret.mockResolvedValue("https://example.com/script.sh");
        mockRunBashAction.mockResolvedValue({ status: 0 });
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

    test("leaves approval handling independent of label reconciliation", async () => {
        payload.label.name = "Approved for 202505 Branch";
        await execute();
        expect(mockPaginate).not.toHaveBeenCalled();
        expect(mockRunBashAction).toHaveBeenCalledWith(expect.arrayContaining([
            'ACTION_LABEL="Approved for 202505 Branch"', 'ACTION_SENDER="maintainer"',
        ]));
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
