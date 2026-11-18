const { planAssignments, assignmentSummary } = require("../reviewer_assignment");
const { parseCodeowners } = require("../codeowners");

describe("reviewer assignment planning", () => {
    const mapping = { "/tests/": { Alice: 0.4, Bob: 0.6, Low: 0.3 }, "/other/": { Bob: 0.5 } };
    const files = [{ filename: "tests/file.py" }, { filename: "tests/second.py" }];
    const pr = { changed_files: 2, head: { sha: "head" }, user: { login: "author" } };
    const none = { rules: [], teams: {} };
    const plan = (options = {}) => planAssignments(
        options.files || files, options.mapping || mapping, options.reviews || [],
        { ...pr, ...options.pr }, options.codeowners || none, options.random || (() => 0),
        null, options.admins || new Set(),
    );

    test("prefers CODEOWNERS and deduplicates selected owners", () => {
        const result = plan({ codeowners: { rules: parseCodeowners("/tests/ @Owner"), teams: {} } });
        expect(result.reviewers).toEqual(["owner", "alice", "bob"]);
        expect(result.rows.filter(row => !row.additional).every(row => row.source === "CODEOWNERS")).toBe(true);
    });

    test("falls back to individual mapping score >= 0.4", () => {
        expect(plan().reviewers).toEqual(["alice", "bob"]);
        expect(plan({ random: () => 0.99 }).reviewers).toEqual(["bob", "alice"]);
        expect(plan().reviewers).not.toContain("low");
    });

    test("reuses existing requests instead of randomizing", () => {
        const result = plan({ pr: { requested_reviewers: [{ login: "BOB" }] } });
        expect(result.reviewers).toEqual(["alice"]);
        expect(result.rows.filter(row => !row.additional).every(row => row.existing)).toBe(true);
    });

    test("reuses selected reviewers across folders", () => {
        const result = plan({ files: [{ filename: "other/file" }, { filename: "tests/file" }] });
        expect(result.reviewers).toEqual(["bob", "alice"]);
    });

    test("requests teams without selecting individual members", () => {
        const codeowners = {
            rules: parseCodeowners("* @sonic-net/owners"), teams: { "sonic-net/owners": ["Member"] },
        };
        expect(plan({ codeowners }).team_reviewers).toEqual(["owners"]);
        const existing = plan({ codeowners, pr: { requested_teams: [{ slug: "owners" }] } });
        expect(existing.team_reviewers).toEqual([]);
        expect(existing.rows[0].existing).toBe(true);
        const memberRequested = plan({ codeowners, pr: { requested_reviewers: [{ login: "Member" }] } });
        expect(memberRequested.team_reviewers).toEqual(["owners"]);
        expect(memberRequested.rows[0].existing).toBe(true);
    });

    test("author-only team and author ownership fall back to mapping", () => {
        expect(plan({ codeowners: {
            rules: parseCodeowners("* @author @sonic-net/owners"), teams: { "sonic-net/owners": ["author"] },
        } }).reviewers).toEqual(["alice", "bob"]);
    });

    test("excludes author and reports folders without candidates", () => {
        const result = plan({ pr: { user: { login: "Alice" } }, mapping: { "/tests/": { Alice: 0.5, Low: 0.3 } } });
        expect(result.reviewers).toEqual([]);
        expect(assignmentSummary(result)).toContain("No eligible reviewer");
        expect(plan({ mapping: { "/tests/": { mssonicbld: 0.9 } } }).reviewers).toEqual([]);
    });

    test("skips already-qualified paths but not stale approvals", () => {
        const review = {
            id: 1, user: { login: "Alice" }, state: "APPROVED",
            submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
        };
        expect(plan({ reviews: [review] }).rows).toEqual([]);
        expect(plan({ reviews: [{ ...review, commit_id: "old" }] }).reviewers).toEqual(["alice", "bob"]);
    });

    test("does not treat a re-requested approver's paths as already qualified", () => {
        const result = plan({
            reviews: [{
                id: 1, user: { login: "Alice" }, state: "APPROVED",
                submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
            }],
            pr: { requested_reviewers: [{ login: "ALICE" }] },
        });
        expect(result.rows.filter(row => !row.additional)).toHaveLength(2);
        expect(result.rows.filter(row => !row.additional).every(row => row.existing)).toBe(true);
        expect(result.reviewers).not.toContain("alice");
    });

    test("administrator approval skips assignment for unmapped and renamed paths", () => {
        const result = plan({
            files: [
                { filename: "unmapped/file.py" },
                { filename: "tests/new.py", previous_filename: "elsewhere/old.py", status: "renamed" },
            ],
            reviews: [{
                id: 1, user: { login: "Admin" }, state: "APPROVED",
                submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
            }],
            admins: new Set(["admin"]),
        });
        expect(result.rows).toEqual([]);
        expect(result.reviewers).toEqual([]);
        expect(result.team_reviewers).toEqual([]);
    });

    test.each(["stale", "dismissed", "author", "bot", "requested"])(
        "an inactive %s administrator does not suppress assignment", reason => {
            const review = {
                id: 1, user: { login: "Admin", type: "User" }, state: "APPROVED",
                submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
            };
            const options = { reviews: [review], admins: new Set(["admin"]), pr: {} };
            if (reason === "stale") review.commit_id = "previous-head";
            else if (reason === "dismissed") review.state = "DISMISSED";
            else if (reason === "author") options.pr.user = { login: "Admin" };
            else if (reason === "bot") review.user.type = "Bot";
            else options.pr.requested_reviewers = [{ login: "ADMIN" }];
            expect(plan(options).reviewers).toEqual(["alice", "bob"]);
        },
    );

    test("uses final CODEOWNERS override and considers both rename paths", () => {
        const result = plan({
            files: [{ filename: "tests/new", previous_filename: "other/old", status: "renamed" }],
            pr: { changed_files: 1 },
            codeowners: { rules: parseCodeowners("* @Default\n/tests/ @Specific"), teams: {} },
        });
        expect(result.reviewers).toEqual(["specific", "default", "alice"]);
    });

    test.each([false, true])("requests the fallback owner for nested docs without a mapping (Docs approved=%s)", approved => {
        const result = plan({
            files: [{ filename: "docs/build-app/troubleshooting.md" }],
            mapping: { "/other/": {} },
            pr: { changed_files: 1 },
            codeowners: { rules: parseCodeowners("* @Default\ndocs/* @Docs"), teams: {} },
            reviews: approved ? [{
                id: 1, user: { login: "Docs" }, state: "APPROVED",
                submitted_at: "2026-10-25T00:00:00Z", commit_id: "head",
            }] : [],
        });
        expect(result.reviewers).toEqual(["default"]);
        expect(result.rows[0].source).toBe("CODEOWNERS");
    });

    test("leaves nested docs unassigned when neither matching owners nor mapped candidates exist", () => {
        const result = plan({
            files: [{ filename: "docs/build-app/troubleshooting.md" }],
            mapping: { "/other/": {} },
            pr: { changed_files: 1 },
            codeowners: { rules: parseCodeowners("docs/* @Docs"), teams: {} },
        });
        expect(result.reviewers).toEqual([]);
        expect(result.rows[0].reviewer).toBeUndefined();
        expect(assignmentSummary(result)).toContain("No eligible reviewer");
    });

    test.each([0, 1, 2, 3])("tops up %s existing requests to three", count => {
        const requested_reviewers = Array.from({ length: count }, (_, i) => ({ login: `Existing${i}` }));
        const result = plan({
            mapping: { "/tests/": { Alice: 0.4, Bob: 0.5, Carol: 0.6, Low: 0.3 } },
            pr: { requested_reviewers: [...requested_reviewers, { login: "Alice" }] },
        });
        expect(result.requestedTotal).toBe(Math.max(3, count + 1));
        expect(result.reviewers).toHaveLength(Math.max(0, 2 - count));
        expect(result.reviewers).not.toContain("low");
    });

    test("counts team and user requests independently and deduplicates top-ups", () => {
        const result = plan({
            pr: { requested_reviewers: [{ login: "Alice" }], requested_teams: [{ slug: "owners" }] },
            codeowners: { rules: parseCodeowners("* @sonic-net/owners"), teams: { "sonic-net/owners": ["Member"] } },
        });
        expect(result.reviewers).toEqual(["bob"]);
        expect(result.team_reviewers).toEqual([]);
        expect(result.requestedTotal).toBe(3);
    });

    test("requests all available candidates if fewer than three exist", () => {
        const result = plan({ mapping: { "/tests/": { Alice: 0.4 } } });
        expect(result.reviewers).toEqual(["alice"]);
        expect(result.requestedTotal).toBe(1);
    });

    test("rejects incomplete lists", () => {
        expect(() => plan({ files: [] })).toThrow("Incomplete");
    });
});
