const { spawn } = require('child_process');

class ActionQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.pending = [];
        this.running = 0;
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.pending.push({ task, resolve, reject });
            this.drain();
        });
    }

    drain() {
        while (this.running < this.concurrency && this.pending.length > 0) {
            const item = this.pending.shift();
            this.running += 1;
            Promise.resolve()
                .then(item.task)
                .then(item.resolve, item.reject)
                .finally(() => {
                    this.running -= 1;
                    this.drain();
                });
        }
    }
}

function runBashAction(params) {
    return new Promise((resolve, reject) => {
        const child = spawn('./bash_action.sh', params);
        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => {
            stdout += data;
        });
        child.stderr.on('data', data => {
            stderr += data;
        });
        child.on('error', reject);
        child.on('close', (status, signal) => {
            resolve({
                status,
                signal,
                stdout,
                stderr,
                output: [null, stdout, stderr],
            });
        });
    });
}

const actionQueue = new ActionQueue(1);

function enqueueBashAction(params, label, app, onComplete) {
    app.log.info(`[ ACTION QUEUE ] Queued ${label}, pending: ${actionQueue.pending.length + 1}`);
    actionQueue.enqueue(async () => {
        app.log.info(`[ ACTION QUEUE ] Started ${label}`);
        const run = await runBashAction(params);
        await onComplete(run);
        app.log.info(`[ ACTION QUEUE ] Finished ${label}, exit code: ${run.status}`);
    }).catch(error => {
        app.log.error(`[ ACTION QUEUE ] Failed ${label}: ${error}`);
    });
}

module.exports = Object.freeze({
    ActionQueue,
    enqueueBashAction,
});
