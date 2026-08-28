const mockGetPullRequest = jest.fn()
const mockCreateComment = jest.fn()
const mockListCheckRuns = jest.fn()
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
            checks: {
                listForRef: mockListCheckRuns,
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
                base: {
                    sha: "expected-base-sha",
                },
                user: {
                    login: "contributor",
                },
            },
        },
    }
}

function createStaleContext(number, createdAt = "2026-08-28T00:00:00Z") {
    return {
        payload: {
            action: "created",
            repository: {
                full_name: "Azure/example.msft",
            },
            issue: {
                number,
                pull_request: {},
            },
            comment: {
                body: "Azure Pipelines will not run the associated pipelines, " +
                    "because the pull request was updated after the run command was issued.",
                created_at: createdAt,
                user: {
                    login: "azure-pipelines[bot]",
                },
            },
        },
    }
}

function currentPullRequest(overrides = {}) {
    return {
        data: {
            state: "open",
            head: {
                sha: "expected-sha",
            },
            base: {
                sha: "expected-base-sha",
            },
            mergeable: true,
            mergeable_state: "clean",
            ...overrides,
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
        mockListCheckRuns.mockResolvedValue({ data: { check_runs: [] } })
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

    test("skips an initial comment when the pull request has merge conflicts", async () => {
        mockGetPullRequest.mockResolvedValue(currentPullRequest({
            mergeable: false,
            mergeable_state: "dirty",
        }))

        await handler(createContext(113))
        jest.advanceTimersByTime(10000)
        await flushPromises()

        expect(mockCreateComment).not.toHaveBeenCalled()
        expect(app.log.info).toHaveBeenCalledWith(
            expect.stringContaining("PR has merge conflicts")
        )
    })

    test("retries a stale Azure comment once for the same revision", async () => {
        mockGetPullRequest.mockResolvedValue(currentPullRequest())

        await handler(createContext(107))
        jest.advanceTimersByTime(10000)
        await flushPromises()

        await handler(createStaleContext(107))
        jest.advanceTimersByTime(14999)
        await flushPromises()
        expect(mockCreateComment).toHaveBeenCalledTimes(1)

        jest.advanceTimersByTime(1)
        await flushPromises()

        expect(mockListCheckRuns).toHaveBeenCalledTimes(1)
        expect(mockCreateComment).toHaveBeenCalledTimes(2)

        await handler(createStaleContext(107, "2026-08-28T00:00:30Z"))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).toHaveBeenCalledTimes(2)
    })

    test("does not reset the retry limit for another event on the same revision", async () => {
        mockGetPullRequest.mockResolvedValue(currentPullRequest())

        await handler(createContext(114))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(114))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        await handler(createContext(114))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(114, "2026-08-28T00:00:30Z"))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).toHaveBeenCalledTimes(3)
        expect(mockListCheckRuns).toHaveBeenCalledTimes(1)
    })

    test("does not retry after the pull request head changes", async () => {
        mockGetPullRequest
            .mockResolvedValueOnce(currentPullRequest())
            .mockResolvedValueOnce(currentPullRequest({
                head: {
                    sha: "new-sha",
                },
            }))

        await handler(createContext(108))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(108))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).toHaveBeenCalledTimes(1)
        expect(mockListCheckRuns).not.toHaveBeenCalled()
    })

    test("does not retry after the pull request base changes", async () => {
        mockGetPullRequest
            .mockResolvedValueOnce(currentPullRequest())
            .mockResolvedValueOnce(currentPullRequest({
                base: {
                    sha: "new-base-sha",
                },
            }))

        await handler(createContext(109))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(109))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).toHaveBeenCalledTimes(1)
        expect(mockListCheckRuns).not.toHaveBeenCalled()
    })

    test("does not retry a pull request with merge conflicts", async () => {
        mockGetPullRequest
            .mockResolvedValueOnce(currentPullRequest())
            .mockResolvedValueOnce(currentPullRequest({
                mergeable: false,
                mergeable_state: "dirty",
            }))

        await handler(createContext(110))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(110))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockCreateComment).toHaveBeenCalledTimes(1)
        expect(mockListCheckRuns).not.toHaveBeenCalled()
    })

    test("does not retry when Azure validation already started", async () => {
        mockGetPullRequest.mockResolvedValue(currentPullRequest())
        mockListCheckRuns.mockResolvedValue({
            data: {
                check_runs: [{
                    app: {
                        slug: "azure-pipelines",
                    },
                    conclusion: null,
                    started_at: "2026-08-28T00:00:01Z",
                }],
            },
        })

        await handler(createContext(111))
        jest.advanceTimersByTime(10000)
        await flushPromises()
        await handler(createStaleContext(111))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockListCheckRuns).toHaveBeenCalledTimes(1)
        expect(mockCreateComment).toHaveBeenCalledTimes(1)
    })

    test("ignores stale comments without a matching auto comment", async () => {
        await handler(createStaleContext(112))
        jest.advanceTimersByTime(15000)
        await flushPromises()

        expect(mockGetPullRequest).not.toHaveBeenCalled()
        expect(mockCreateComment).not.toHaveBeenCalled()
    })
})
