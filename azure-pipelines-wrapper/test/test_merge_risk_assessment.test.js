const mockGetToken = jest.fn();
jest.mock("@azure/identity", () => ({
    DeviceCodeCredential: jest.fn(function () { return { getToken: mockGetToken }; }),
    ManagedIdentityCredential: jest.fn(function () { return { getToken: mockGetToken }; }),
}));
const { DeviceCodeCredential, ManagedIdentityCredential } = require("@azure/identity");
const { main } = require("../test_merge_risk_assessment");

describe("terminal merge risk API test", () => {
    const env = {
        ENTRA_TENANT_ID: "tenant", ENTRA_DEV_CLIENT_ID: "public-client",
        ADO_MI_CLIENT_ID: "configured-managed-identity",
    };
    const originalFetch = global.fetch;
    const originalAbortSignal = global.AbortSignal;
    let mockFetch;
    let mockText;
    let signal;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        mockGetToken.mockReset().mockResolvedValue({ token: "secret-access-token" });
        mockText = jest.fn().mockResolvedValue('{"id":"task-123"}');
        mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 201, text: mockText });
        signal = {};
        global.fetch = mockFetch;
        global.AbortSignal = { timeout: jest.fn(() => signal) };
    });

    afterEach(() => {
        global.fetch = originalFetch;
        global.AbortSignal = originalAbortSignal;
        jest.restoreAllMocks();
    });

    test.each([[[]], [["--help"]]])("shows help without authentication or submission: %p", async args => {
        await main(args, {});
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining("REAL assessment task"));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining("omits model"));
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each([["--unknown"], ["--submit", "--help"]])("rejects unsupported arguments: %p", async (...args) => {
        await expect(main(args, env)).rejects.toThrow("Unsupported arguments");
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each([{}, { ENTRA_TENANT_ID: "tenant" }, { ENTRA_DEV_CLIENT_ID: "client" }])(
        "requires explicit sign-in configuration: %p", async incomplete => {
            await expect(main(["--submit"], incomplete)).rejects.toThrow("Set ENTRA_TENANT_ID");
            expect(mockGetToken).not.toHaveBeenCalled();
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    test("reports unsupported Node.js runtimes before sign-in", async () => {
        global.fetch = undefined;
        await expect(main(["--submit"], env)).rejects.toThrow("Node.js 18");
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("authenticates, submits the exact payload, and prints the response without the token", async () => {
        await main(["--submit"], env);
        expect(DeviceCodeCredential).toHaveBeenCalledWith({
            tenantId: "tenant", clientId: "public-client", userPromptCallback: expect.any(Function),
        });
        DeviceCodeCredential.mock.calls[0][0].userPromptCallback({ message: "Open browser and enter code" });
        expect(console.error).toHaveBeenCalledWith("Open browser and enter code");
        expect(mockGetToken).toHaveBeenCalledWith("api://sonic-testbed-tools-prod/.default");
        expect(mockFetch).toHaveBeenCalledWith(
            "https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net/v1/task-plans/github-app",
            {
                method: "POST", redirect: "manual", signal,
                headers: {
                    Authorization: "Bearer secret-access-token",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    type: "MERGE_RISK_ASSESSMENT",
                    pbi_id: "40516754",
                    description: "Terminal smoke test: assess merge risk for the PR documented in PBI 40516754.",
                }),
            },
        );
        expect(global.AbortSignal.timeout).toHaveBeenCalledWith(60000);
        expect(console.log).toHaveBeenCalledWith("HTTP 201");
        expect(console.log).toHaveBeenCalledWith('{"id":"task-123"}');
        expect(JSON.stringify([...console.log.mock.calls, ...console.error.mock.calls]))
            .not.toContain("secret-access-token");
    });

    test("handles successful empty responses", async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 204, text: mockText });
        mockText.mockResolvedValue("");
        await main(["--submit"], env);
        expect(console.log).toHaveBeenCalledWith("(empty response body)");
    });

    test.each([
        [["--managed-identity", "--submit"]],
        [["--submit", "--managed-identity"]],
    ])("uses the attached managed identity without development configuration: %p", async args => {
        await main(args, { ADO_MI_CLIENT_ID: "configured-managed-identity" });
        expect(ManagedIdentityCredential).toHaveBeenCalledWith({
            clientId: "configured-managed-identity",
        });
        expect(DeviceCodeCredential).not.toHaveBeenCalled();
        expect(mockGetToken).toHaveBeenCalledWith("api://sonic-testbed-tools-prod/.default");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe(
            "https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net/v1/task-plans/github-app",
        );
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
            type: "MERGE_RISK_ASSESSMENT",
            pbi_id: "40516754",
            description: "Terminal smoke test: assess merge risk for the PR documented in PBI 40516754.",
        });
        expect(console.log).toHaveBeenCalledWith("HTTP 201");
    });

    test.each([{}, { ADO_MI_CLIENT_ID: "" }, { ADO_MI_CLIENT_ID: "   " }])(
        "requires an explicit managed identity client ID: %p", async incomplete => {
            await expect(main(["--managed-identity", "--submit"], incomplete))
                .rejects.toThrow("Set ADO_MI_CLIENT_ID");
            expect(ManagedIdentityCredential).not.toHaveBeenCalled();
            expect(DeviceCodeCredential).not.toHaveBeenCalled();
            expect(mockGetToken).not.toHaveBeenCalled();
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    test.each([
        [["--managed-identity"]],
        [["--submit", "--submit"]],
        [["--managed-identity", "--managed-identity", "--submit"]],
        [["--managed-identity", "--unknown"]],
    ])("rejects incomplete or duplicate flags: %p", async args => {
        await expect(main(args, {})).rejects.toThrow("Unsupported arguments");
        expect(mockGetToken).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("does not fall back to browser sign-in when managed identity fails", async () => {
        mockGetToken.mockRejectedValue(new Error("Managed identity is unavailable"));
        await expect(main(["--managed-identity", "--submit"], env))
            .rejects.toThrow("Managed identity is unavailable");
        expect(DeviceCodeCredential).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each([302, 400, 401, 403, 500])("prints HTTP %s failures and rejects without retrying", async status => {
        mockFetch.mockResolvedValue({ ok: false, status, text: mockText });
        mockText.mockResolvedValue('{"error":"request rejected"}');
        await expect(main(["--submit"], env)).rejects.toThrow(`HTTP ${status}`);
        expect(console.log).toHaveBeenCalledWith('{"error":"request rejected"}');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Task submission succeeded"));
    });

    test("does not submit after an authentication error", async () => {
        mockGetToken.mockRejectedValue(new Error("Consent required"));
        await expect(main(["--submit"], env)).rejects.toThrow("Consent required");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each([null, {}, { token: "" }])("does not submit without an access token: %p", async token => {
        mockGetToken.mockResolvedValue(token);
        await expect(main(["--submit"], env)).rejects.toThrow("no access token");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each(["connection", "response body"])("warns about ambiguous %s failures without retrying", async stage => {
        if (stage === "connection") mockFetch.mockRejectedValue(new Error("Timed out"));
        else mockText.mockRejectedValue(new Error("Connection lost"));
        await expect(main(["--submit"], env)).rejects.toThrow("check the scheduler before retrying");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Task submission succeeded"));
    });
});
