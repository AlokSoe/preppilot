import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HARNESS = readFileSync(new URL('./harness.cjs', import.meta.url), 'utf8');
const MAX_CODE_CHARS = 100_000;
const MAX_TESTS = 50;
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * @typedef {{ name: string, code: string }} TestCase
 * @typedef {{ name: string, passed: boolean, error?: string, ms: number }} TestResult
 * @typedef {{
 *   status: 'ok' | 'compile_error' | 'timeout' | 'memory_limit' | 'crashed' | 'cancelled',
 *   tests: TestResult[],
 *   passed: number,
 *   total: number,
 *   logs: string,
 *   error?: string,
 *   durationMs: number,
 * }} RunResult
 */

/**
 * Runs untrusted JavaScript against tests, each run in its own sandboxed
 * Node process (design doc §9.5):
 *
 *   node --permission            no file system, child processes, workers,
 *                                native addons or network
 *   --max-old-space-size         heap cap
 *   env: {}                      no API keys or other secrets
 *   wall-clock timeout           SIGKILL, so even `while (true) {}` stops
 *
 * A semaphore limits how many runs execute at once; the rest queue, so
 * CPU-heavy code can't starve the API server.
 *
 * In production the runner also lives in its own container with no network
 * and a memory limit (the heap cap doesn't cover Buffers).
 */
export class CodeRunner {
  #active = 0;
  /** @type {(() => void)[]} */
  #waiting = [];

  constructor({ concurrency = 4, timeoutMs = 5000, memoryMb = 128 } = {}) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.memoryMb = memoryMb;
  }

  /**
   * @param {{ code: string, tests: TestCase[] }} job
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<RunResult>}
   */
  async run({ code, tests }, { signal } = {}) {
    if (typeof code !== 'string' || code.length > MAX_CODE_CHARS) {
      throw new RangeError(`Code must be a string of at most ${MAX_CODE_CHARS} characters`);
    }
    if (!Array.isArray(tests) || tests.length > MAX_TESTS) throw new RangeError(`At most ${MAX_TESTS} tests`);

    await this.#acquire();
    try {
      return await this.#spawn({ code, tests }, signal);
    } finally {
      this.#release();
    }
  }

  async #acquire() {
    if (this.#active < this.concurrency) {
      this.#active++;
      return;
    }
    await new Promise((resolve) => this.#waiting.push(() => resolve(undefined)));
  }

  #release() {
    const next = this.#waiting.shift();
    if (next) next(); // hand the slot straight to the next run
    else this.#active--;
  }

  /** @returns {Promise<RunResult>} */
  #spawn(job, signal) {
    const started = performance.now();
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--permission', `--max-old-space-size=${this.memoryMb}`, '-e', HARNESS],
        { env: {}, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
      );

      /** @type {TestResult[]} */
      const tests = [];
      /** @type {any} */
      let done = null;
      let resultBuffer = '';
      let output = '';
      let stderr = '';
      /** @type {RunResult['status'] | null} */
      let killedFor = null;

      const capture = (chunk, append) => append(chunk.toString('utf8'));
      child.stdout.on('data', (c) =>
        capture(c, (s) => {
          if (output.length < MAX_CAPTURE_BYTES) output += s;
        }),
      );
      child.stderr.on('data', (c) =>
        capture(c, (s) => {
          if (stderr.length < MAX_CAPTURE_BYTES) stderr += s;
        }),
      );
      /** @type {import('node:stream').Readable} */ (child.stdio[3]).on('data', (chunk) => {
        resultBuffer += chunk.toString('utf8');
        let newline;
        while ((newline = resultBuffer.indexOf('\n')) !== -1) {
          const line = resultBuffer.slice(0, newline);
          resultBuffer = resultBuffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'test') tests.push({ name: message.name, passed: message.passed, error: message.error, ms: message.ms });
            else if (message.type === 'done') done = message;
          } catch {
            // ignore malformed lines
          }
        }
        if (resultBuffer.length > MAX_CAPTURE_BYTES) child.kill('SIGKILL');
      });

      const kill = (reason) => {
        killedFor ??= reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('timeout'), this.timeoutMs);
      const onAbort = () => kill('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        stderr += String(err);
      });
      child.on('close', (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        /** @type {RunResult['status']} */
        let status;
        let error = done?.error;
        if (killedFor) {
          status = killedFor;
          error = killedFor === 'timeout' ? `Stopped after ${this.timeoutMs} ms (infinite loop?)` : 'Run cancelled';
        } else if (/heap out of memory|Allocation failed/i.test(stderr)) {
          status = 'memory_limit';
          error = `Used more than ${this.memoryMb} MB of memory`;
        } else if (done) {
          status = done.status;
        } else {
          status = 'crashed';
          error = (stderr.trim().split('\n').at(-1) || `Exited with ${exitSignal ?? exitCode}`).slice(0, 500);
        }

        // Tests that never reported (crash / timeout) count as failed.
        const reported = new Set(tests.map((t) => t.name));
        if (status !== 'compile_error') {
          for (const test of job.tests) {
            if (!reported.has(test.name)) tests.push({ name: test.name, passed: false, error: `Not completed (${status})`, ms: 0 });
          }
        }
        const logs = `${output}${done?.logs ?? ''}`.slice(0, MAX_CAPTURE_BYTES);
        resolve({
          status,
          tests,
          passed: tests.filter((t) => t.passed).length,
          total: job.tests.length,
          logs,
          ...(error && { error }),
          durationMs: Math.round(performance.now() - started),
        });
      });

      child.stdin.on('error', () => {}); // child may exit before reading everything
      child.stdin.end(JSON.stringify(job));
    });
  }
}
