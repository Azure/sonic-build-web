const mockCreateComment = jest.fn();
const mockEnqueueAction = jest.fn();

jest.mock("@octokit/auth-token", () => ({ createTokenAuth: jest.fn() }));
jest.mock("@octokit/request", () => ({ request: jest.fn() }));
jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(() => ({
        rest: {
            issues: {
                createComment: mockCreateComment,
            },
        },
    })),
}));
jest.mock("@azure/core-amqp", () => ({ retry: jest.fn() }));
jest.mock("../azp", () => ({}));
jest.mock("../keyvault", () => ({
    getGithubToken: jest.fn().mockResolvedValue("github-token"),
}));
jest.mock("../adoauth", () => ({}));
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
    };

    beforeEach(() => {
        jest.clearAllMocks();
        issueComment.init(app);
    });

    test("reports a full queue without posting retry success", async () => {
        mockEnqueueAction.mockImplementation(() => {
            throw new Error("Action queue is full (100 pending)");
        });

        await handler(context);

        expect(mockCreateComment).toHaveBeenCalledTimes(1);
        expect(mockCreateComment.mock.calls[0][0].body)
            .toBe("Unable to queue the retry because the action queue is full. Please try again later.");
    });

    test("does not post retry success before the queued action starts", async () => {
        mockEnqueueAction.mockReturnValue(Promise.resolve());

        await handler(context);

        expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        expect(mockCreateComment).not.toHaveBeenCalled();
    });
});
