const mockCreateComment = jest.fn();
const mockContextCreateComment = jest.fn();
const mockEnqueueAction = jest.fn();
const mockGetCollaboratorPermissionLevel = jest.fn();
const mockGetGithubToken = jest.fn().mockResolvedValue("github-token");

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
    getGithubToken: mockGetGithubToken,
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
                    getCollaboratorPermissionLevel: mockGetCollaboratorPermissionLevel,
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
        mockGetCollaboratorPermissionLevel.mockResolvedValue({
            data: {
                permission: "push",
            },
        });
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

    test.each(["write", "push", "maintain", "admin"])(
        "allows a commenter with %s permission to queue a retry",
        async (permission) => {
            mockEnqueueAction.mockReturnValue(Promise.resolve());
            mockGetCollaboratorPermissionLevel.mockResolvedValue({
                data: {
                    permission: permission,
                },
            });

            await handler(context);

            expect(mockEnqueueAction).toHaveBeenCalledTimes(1);
        }
    );

    test.each([
        ["/azpw retry", "read"],
        ["/azpw run", "triage"],
        ["/azurepipelineswrapper retry", "none"],
        ["/azurepipelineswrapper run", "unknown"],
    ])("denies %s from a commenter with %s permission", async (command, permission) => {
        context.payload.comment.body = command;
        mockGetCollaboratorPermissionLevel.mockResolvedValue({
            data: {
                permission: permission,
            },
        });

        await handler(context);

        expect(mockGetGithubToken).not.toHaveBeenCalled();
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockContextCreateComment).toHaveBeenCalledWith({
            owner: "sonic-net",
            repo: "sonic-buildimage",
            issue_number: 42,
            body: "You are not authorized to retry Azure Pipelines jobs for this repository.",
        });
    });

    test("denies a retry when the commenter permission lookup fails", async () => {
        mockGetCollaboratorPermissionLevel.mockRejectedValue(new Error("GitHub unavailable"));

        await handler(context);

        expect(app.log.error).toHaveBeenCalledTimes(1);
        expect(mockGetGithubToken).not.toHaveBeenCalled();
        expect(mockEnqueueAction).not.toHaveBeenCalled();
        expect(mockCreateComment).not.toHaveBeenCalled();
        expect(mockContextCreateComment).toHaveBeenCalledWith({
            owner: "sonic-net",
            repo: "sonic-buildimage",
            issue_number: 42,
            body: "You are not authorized to retry Azure Pipelines jobs for this repository.",
        });
    });
});
