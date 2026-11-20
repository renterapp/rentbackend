const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { app } = require('../src/server.ts');

test('malformed JSON returns a safe JSON error without breaking subsequent requests', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  for (const body of ['{bad}', '{"email":', '{"email":"private@example.com",}']) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const error = await response.json();
    assert.equal(typeof error.error, 'string');
    assert.ok(error.error.length > 0);
    assert.doesNotMatch(JSON.stringify(error), /SyntaxError|node_modules|private@example.com/);
  }

  const valid = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(valid.status, 400);
  assert.match((await valid.json()).error, /[Rr]equired/);
  assert.equal((await fetch(url)).status, 200);

  const oversized = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(110_000) }),
  });
  assert.equal(oversized.status, 413);
});
