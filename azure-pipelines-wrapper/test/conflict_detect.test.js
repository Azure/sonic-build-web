const mockGetPullRequest = jest.fn()
const mockCreateComment = jest.fn()
const mockGetGithubToken = jest.fn()
const mockEnqueueBashAction = jest.fn()

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
    sendEventBatch: jest.fn(),
}))
jest.mock("../keyvault", () => ({
    getGithubToken: mockGetGithubToken,
}))
jest.mock("../adoauth", () => ({}))

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
        mockGetGithubToken.mockResolvedValue("github-token")
        mockCreateComment.mockResolvedValue({ data: { id: 1 } })
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
        jest.advanceTimersByTime(15000)
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
        jest.advanceTimersByTime(15000)
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
        jest.advanceTimersByTime(15000)
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
        jest.advanceTimersByTime(15000)
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
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).not.toHaveBeenCalled()
        expect(app.log.info).toHaveBeenCalledWith(
            expect.stringContaining("PR is closed")
        )
    })
})
