import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteRunner, startRunnerService } from '../src/runner/service.js';

const TOKEN = 'test-runner-token-0123456789';
let server;
let url;

before(async () => {
  server = await startRunnerService({ host: '127.0.0.1', port: 0, token: TOKEN });
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('RemoteRunner runs code through the service, same result shape as CodeRunner', async () => {
  const runner = new RemoteRunner({ url, token: TOKEN });
  const result = await runner.run({
    code: 'const double = (x) => x * 2;',
    tests: [
      { name: 'doubles', code: 'assert.equal(double(2), 4);' },
      { name: 'wrong', code: 'assert.equal(double(2), 5);' },
    ],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.passed, 1);
  assert.equal(result.total, 2);
});

test('a wrong token is rejected', async () => {
  const runner = new RemoteRunner({ url, token: 'wrong-token-0123456789' });
  await assert.rejects(runner.run({ code: '', tests: [] }), /HTTP 401/);
});

test('invalid input surfaces as RangeError, like the local runner', async () => {
  const runner = new RemoteRunner({ url, token: TOKEN });
  await assert.rejects(runner.run({ code: 'x'.repeat(100_001), tests: [] }), RangeError);
});

test('the service refuses to start without a real token', async () => {
  await assert.rejects(startRunnerService({ port: 0, token: '' }), /RUNNER_TOKEN/);
});
