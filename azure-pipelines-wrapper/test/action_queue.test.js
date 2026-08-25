const { ActionQueue } = require("../action_queue");

describe("ActionQueue", () => {
    test("runs queued actions one at a time", async () => {
        const queue = new ActionQueue(1);
        const order = [];
        let active = 0;
        let maxActive = 0;

        const task = id => queue.enqueue(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push(`start-${id}`);
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push(`end-${id}`);
            active -= 1;
        });

        await Promise.all([task(1), task(2), task(3)]);

        expect(maxActive).toBe(1);
        expect(order).toEqual([
            "start-1", "end-1",
            "start-2", "end-2",
            "start-3", "end-3",
        ]);
    });

    test("continues after a queued action fails", async () => {
        const queue = new ActionQueue(1);
        const order = [];

        const failed = queue.enqueue(async () => {
            order.push("failed");
            throw new Error("test failure");
        });
        const succeeded = queue.enqueue(async () => {
            order.push("succeeded");
        });

        await expect(failed).rejects.toThrow("test failure");
        await succeeded;
        expect(order).toEqual(["failed", "succeeded"]);
    });

    test("rejects actions when the pending limit is reached", async () => {
        const queue = new ActionQueue(1, 1);
        let release;
        const blocker = new Promise(resolve => {
            release = resolve;
        });

        const running = queue.enqueue(() => blocker);
        const pending = queue.enqueue(async () => {});

        expect(() => queue.enqueue(async () => {}))
            .toThrow("Action queue is full (1 pending)");

        release();
        await Promise.all([running, pending]);
    });
});
