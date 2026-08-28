const mockGetPullRequest = jest.fn()
const mockCreateComment = jest.fn()
const mockCreateCheck = jest.fn()
const mockCheckMembership = jest.fn()
const mockGetGithubToken = jest.fn()
const mockGetSecret = jest.fn()
const mockGetAdoToken = jest.fn()
const mockEnqueueBashAction = jest.fn()
const mockSendEventBatch = jest.fn()

jest.mock("@octokit/rest", () => ({
    Octokit: jest.fn(() => ({
        rest: {
            pulls: {
                get: mockGetPullRequest,
            },
            issues: {
                createComment: mockCreateComment,
            },
        },
    })),
}))
jest.mock("@azure/communication-email", () => ({
    EmailClient: jest.fn(),
}))
jest.mock("../action_queue", () => ({
    enqueueBashAction: mockEnqueueBashAction,
}))
jest.mock("../eventhub", () => ({
    sendEventBatch: mockSendEventBatch,
}))
jest.mock("../keyvault", () => ({
    getGithubToken: mockGetGithubToken,
    getSecretFromCache: mockGetSecret,
}))
jest.mock("../adoauth", () => ({
    getAdoAadToken: mockGetAdoToken,
}))

const conflictDetect = require("../conflict_detect")

function createContext(number, sha = "expected-sha") {
    return {
        payload: {
            action: "synchronize",
            number,
            repository: {
                full_name: "Azure/example.msft",
            },
            pull_request: {
                head: {
                    sha,
                },
                user: {
                    login: "contributor",
                },
            },
        },
    }
}

function createConflictContext(number) {
    return {
        payload: {
            action: "synchronize",
            number,
            repository: {
                full_name: "sonic-net/sonic-buildimage",
            },
            pull_request: {
                title: "Test pull request",
                html_url: `https://github.com/sonic-net/sonic-buildimage/pull/${number}`,
                head: {
                    sha: "expected-sha",
                },
                base: {
                    ref: "master",
                },
                user: {
                    login: "contributor",
                },
            },
        },
        octokit: {
            rest: {
                checks: {
                    create: mockCreateCheck,
                },
                orgs: {
                    checkMembershipForUser: mockCheckMembership,
                },
            },
        },
    }
}

async function flushPromises() {
    for (let i = 0; i < 10; i += 1) {
        await Promise.resolve()
    }
}

describe("pull request validation comments", () => {
    let handler
    let app

    beforeEach(() => {
        jest.useFakeTimers()
        jest.clearAllMocks()
        mockEnqueueBashAction.mockReset()
        mockGetGithubToken.mockResolvedValue("github-token")
        mockGetSecret.mockResolvedValue("secret")
        mockGetAdoToken.mockResolvedValue("ado-token")
        mockCreateComment.mockResolvedValue({ data: { id: 1 } })
        mockCreateCheck.mockResolvedValue({ status: 201 })
        mockCheckMembership.mockResolvedValue({ status: 204 })
        mockSendEventBatch.mockResolvedValue(undefined)
        mockEnqueueBashAction.mockResolvedValue(undefined)
        app = {
            log: {
                info: jest.fn(),
                error: jest.fn(),
            },
            on: jest.fn((events, callback) => {
                handler = callback
            }),
        }
        conflictDetect.init(app)
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test("returns before the delayed comment runs", async () => {
        await handler(createContext(101))

        expect(mockGetGithubToken).not.toHaveBeenCalled()
        expect(mockGetPullRequest).not.toHaveBeenCalled()
        expect(mockCreateComment).not.toHaveBeenCalled()
    })

    test("comments when the pull request head remains unchanged", async () => {
        mockGetPullRequest.mockResolvedValue({
            data: {
                state: "open",
                head: {
                    sha: "expected-sha",
                },
            },
        })

        await handler(createContext(102))
        jest.advanceTimersByTime(10000)
        await flushPromises()

        expect(mockGetPullRequest).toHaveBeenCalledTimes(1)
        expect(mockCreateComment).toHaveBeenCalledWith({
            owner: "Azure",
            repo: "example.msft",
            issue_number: "102",
            body: "/azp run",
        })
    })

    test("skips a stale pull request event", async () => {
        mockGetPullRequest.mockResolvedValue({
            data: {
                state: "open",
                head: {
                    sha: "new-sha",
                },
            },
        })

        await handler(createContext(103))
        jest.advanceTimersByTime(10000)
        await flushPromises()

        expect(mockGetPullRequest).toHaveBeenCalledTimes(1)
        expect(mockCreateComment).not.toHaveBeenCalled()
        expect(app.log.info).toHaveBeenCalledWith(
            expect.stringContaining("Skip stale event")
        )
    })

    test("deduplicates pending comments for the same revision", async () => {
        mockGetPullRequest.mockResolvedValue({
            data: {
                state: "open",
                head: {
                    sha: "expected-sha",
                },
            },
        })
        const context = createContext(104)

        await handler(context)
        await handler(context)
        jest.advanceTimersByTime(10000)
        await flushPromises()

        expect(mockGetPullRequest).toHaveBeenCalledTimes(1)
        expect(mockCreateComment).toHaveBeenCalledTimes(1)
    })

    test("retries a failed pull request refresh once", async () => {
        mockGetPullRequest
            .mockRejectedValueOnce(new Error("temporary failure"))
            .mockResolvedValueOnce({
                data: {
                    state: "open",
                    head: {
                        sha: "expected-sha",
                    },
                },
            })

        await handler(createContext(105))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        expect(mockGetPullRequest).toHaveBeenCalledTimes(1)

        jest.advanceTimersByTime(1000)
        await flushPromises()

        expect(mockGetPullRequest).toHaveBeenCalledTimes(2)
        expect(mockCreateComment).toHaveBeenCalledTimes(1)
    })

    test("skips a pull request closed during the delay", async () => {
        mockGetPullRequest.mockResolvedValue({
            data: {
                state: "closed",
                head: {
                    sha: "expected-sha",
                },
            },
        })

        await handler(createContext(106))
        jest.advanceTimersByTime(10000)
        await flushPromises()

        expect(mockCreateComment).not.toHaveBeenCalled()
        expect(app.log.info).toHaveBeenCalledWith(
            expect.stringContaining("PR is closed")
        )
    })

    test.each([
        [253, "action_required"],
        [254, "action_required"],
        [251, "failure"],
    ])("maps conflict exit status %i to %s", async (status, conclusion) => {
        mockEnqueueBashAction.mockImplementation(
            async (getArgs, label, queuedApp, onComplete) => onComplete({
                status,
                stdout: [
                    "pr_owner: contributor",
                    "ms_pr: https://dev.azure.com/example/pullrequest/1",
                    "ms_conflict.result: failure",
                ].join("\n"),
            })
        )

        await handler(createConflictContext(200 + status))
        await flushPromises()

        const conflictCheck = mockCreateCheck.mock.calls.find(
            ([params]) => params.name === "ms_conflict"
        )
        expect(conflictCheck).toBeDefined()
        expect(conflictCheck[0]).toEqual(expect.objectContaining({
            status: "completed",
            conclusion,
        }))
    })
})
