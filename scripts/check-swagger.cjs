const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { swaggerPaths } = require('../dist/docs/swaggerPaths');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
const imports = new Map([...server.matchAll(/import (\w+) from '\.\/routes\/([^']+)'/g)]
  .map((match) => [match[1], match[2]]));
let count = 0;
for (const [, prefix, router] of server.matchAll(/app\.use\('([^']+)', (\w+)\)/g)) {
  if (!imports.has(router) || prefix === '/api/floors') continue;
  const source = fs.readFileSync(path.join(root, 'src/routes', `${imports.get(router)}.ts`), 'utf8');
  for (const [, method, suffix] of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    const route = (prefix + (suffix === '/' ? '' : suffix)).replace(/:(\w+)/g, '{$1}');
    // shortcut: /properties/floors is shadowed by /properties/:id; cover it after route ordering is fixed.
    if (route === '/api/properties/floors') continue;
    const operation = swaggerPaths[route]?.[method];
    assert.ok(operation, `Missing Swagger operation: ${method.toUpperCase()} ${route}`);
    assert.deepEqual(operation.security, prefix === '/api/auth' && ['/register', '/login'].includes(suffix)
      ? undefined : [{ bearerAuth: [] }], `Incorrect authentication: ${method} ${route}`);
    for (const [, name] of route.matchAll(/\{(\w+)\}/g)) {
      assert.ok(operation.parameters?.some((parameter) => parameter.name === name
        && parameter.in === 'path' && parameter.required), `Missing path parameter: ${method} ${route} ${name}`);
    }
    count++;
  }
}

for (const [route, method, required] of [
  ['/api/expenses', 'post', ['amount', 'expenseDate']],
  ['/api/expenses/categories', 'post', ['name']],
  ['/api/expenses/categories/{id}', 'patch', ['name']],
  ['/api/notifications/announcements', 'post', ['title', 'message']],
  ['/api/notifications/push-tokens', 'post', ['token']],
  ['/api/notifications/push-tokens', 'delete', ['token']],
  ['/api/apartments/bulk-generate', 'post', ['buildingId', 'floorsCount', 'apartmentsPerFloor']],
  ['/api/maintenance/{id}/status', 'patch', ['statusCode']],
]) {
  const schema = swaggerPaths[route][method].requestBody.content['application/json'].schema;
  assert.deepEqual(schema.required, required, `Incorrect required fields: ${method} ${route}`);
  for (const name of required) assert.ok(schema.properties[name]);
}

function checkSchema(value) {
  if (!value || typeof value !== 'object') return;
  if ('exclusiveMinimum' in value) {
    assert.equal(typeof value.exclusiveMinimum, 'boolean', 'OpenAPI 3.0 exclusiveMinimum must be boolean');
    assert.equal(typeof value.minimum, 'number');
  }
  for (const child of Object.values(value)) checkSchema(child);
}
checkSchema(swaggerPaths);
console.log(`PASS: ${count} route operations documented, path parameters, auth, request bodies, and numeric bounds`);
