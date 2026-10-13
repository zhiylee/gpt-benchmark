// Isolated integration checks; no real API keys or production database are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-settings-'));
process.env.DATABASE_PATH = path.join(temporary, 'test.db');
process.env.ADMIN_KEY = 'integration-test-only';
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { NextRequest } = require('next/server');
const { db, getDashboardData, getSettings, calculateStats, saveSettings } = require('../lib/db.ts');
const { createSessionToken } = require('../lib/auth.ts');
const config = require('../app/api/admin/config/route.ts');
const groups = require('../app/api/admin/groups/route.ts');
const groupRoute = require('../app/api/admin/groups/[id]/route.ts');
const dashboard = require('../app/api/dashboard/route.ts');
const { enqueueGroups, listJobs, cancelJob } = require('../lib/jobs.ts');
const detailRoute = require('../app/api/runs/[id]/route.ts');
const runRoute = require('../app/api/admin/run/route.ts');
const { shanghaiDayStart, isIdleTime } = require('../lib/time.ts');
function checkMiddleware() {
  const previousOrigin = process.env.EMBED_ORIGIN;
  const modulePath = require.resolve('../middleware.ts');
  try {
    for (const origin of [undefined, '', '   ', ' https://embed.example.com ']) {
      if (origin === undefined) delete process.env.EMBED_ORIGIN;
      else process.env.EMBED_ORIGIN = origin;
      delete require.cache[modulePath];
      const { middleware } = require(modulePath);
      const allowedOrigin = origin?.trim() || null;
      for (const [pathname, method] of [['/', 'GET'], ['/api/dashboard', 'GET'], ['/api/dashboard', 'OPTIONS']]) {
        const response = middleware(new NextRequest(`http://localhost${pathname}`, { method }));
        assert.equal(response.headers.get('Content-Security-Policy'), `frame-ancestors 'self'${allowedOrigin ? ` ${allowedOrigin}` : ''}`);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
        assert.equal(response.headers.get('Access-Control-Allow-Credentials'), allowedOrigin ? 'true' : null);
        if (method === 'OPTIONS') {
          assert.equal(response.status, 204);
          assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
          assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization');
        }
      }
    }
  } finally {
    if (previousOrigin === undefined) delete process.env.EMBED_ORIGIN;
    else process.env.EMBED_ORIGIN = previousOrigin;
    delete require.cache[modulePath];
  }
}
async function waitUntil(check) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 6000) throw new Error('Timed out waiting for job');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function runGroup(id) {
  const [job] = enqueueGroups([id]);
  await waitUntil(() => !['queued', 'running'].includes(listJobs().find(j => j.id === job.id)?.status));
}
function request(url, method = 'GET', body, admin = true) {
  return new NextRequest(`http://localhost${url}`, { method, headers: {
    'Content-Type': 'application/json', ...(admin ? { cookie: `benchmark_admin=${createSessionToken()}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let mode = 'success';
let received;
let requestCount = 0;
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received = JSON.parse(body);
  requestCount++;
  if (mode === 'stall') {
    if (received.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    }
    return;
  }
  if (mode === 'abrupt') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"21"}\n\n');
    return;
  }
  if (mode === 'complete-open') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.reasoning_text.delta', delta: 'internal' },
      { type: 'response.reasoning_summary_text.delta', delta: 'summary' },
      { type: 'response.reasoning_summary_text.delta', delta: ' continued' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', output_index: 0, summary_index: 1, delta: 'next paragraph' },
      { type: 'response.completed', response: { id: 'test', status: 'completed', output: [], output_text: '21' } },
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'test', status: mode === 'incomplete' ? 'incomplete' : 'completed', output: [], output_text: '21' }));
});

async function main() {
  checkMiddleware();
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  assert.equal(getSettings().timeoutSeconds, 120);
  db.prepare("UPDATE questions SET pass_pattern = '21'").run();
  assert.equal(shanghaiDayStart(new Date('2026-09-18T01:00:00Z')), '2026-09-17T16:00:00.000Z');
  assert.equal(shanghaiDayStart(new Date('2026-09-17T15:59:59Z')), '2026-09-16T16:00:00.000Z');
  assert.equal(isIdleTime(new Date('2026-09-17T16:00:00Z')), true);
  assert.equal(isIdleTime(new Date('2026-09-18T00:00:00Z')), false);
  const stats = calculateStats([{ status: 'passed' }, ...Array.from({ length: 47 }, () => ({ status: 'error' }))]);
  assert.equal(stats.passRate, 100);
  assert.equal(stats.validSamples, 1);
  assert(stats.availability < 3);
  assert.equal(calculateStats([{ status: 'cancelled' }, { status: 'running' }]).availability, null);
  const threshold = calculateStats([...Array.from({ length: 43 }, () => ({ status: 'passed' })), ...Array.from({ length: 5 }, () => ({ status: 'failed' }))]);
  assert(threshold.passRate < 90);
  assert.equal((await config.PATCH(request('/api/admin/config', 'PATCH', { timeoutSeconds: 1 }, false))).status, 401);
  for (const timeoutSeconds of [0, -1, 1.5, 86401, null, '120']) {
    assert.equal((await config.PATCH(request('/api/admin/config', 'PATCH', { timeoutSeconds }))).status, 400);
  }
  assert.equal((await config.PATCH(request('/api/admin/config', 'PATCH', { timeoutSeconds: 1 }))).status, 200);
  assert.equal(getSettings().timeoutSeconds, 1);
  assert.equal((await config.PATCH(request('/api/admin/config', 'PATCH', { timeoutSeconds: 1, maxConcurrentGroups: 0 }))).status, 400);
  const payload = { name: 'private-test-group', model: 'mock', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'test', enabled: false, streaming: false, isPublic: false, reasoningEffort: 'xhigh' };
  const response = await groups.POST(request('/api/admin/groups', 'POST', payload));
  assert.equal(response.status, 201);
  const { id } = await response.json();
  await runGroup(id);
  assert.equal(received.reasoning.effort, 'xhigh');
  assert.equal(db.prepare('SELECT reasoning_effort FROM runs WHERE group_id = ?').get(id).reasoning_effort, 'xhigh');
  const admin = await (await dashboard.GET(request('/api/dashboard'))).json();
  const guestResponse = await dashboard.GET(request('/api/dashboard', 'GET', undefined, false));
  const guest = await guestResponse.json();
  assert(!JSON.stringify(guest).includes('private-test-group'));
  assert.equal(admin.summary.checksToday, guest.summary.checksToday + 1);
  assert(admin.recentRuns.some(run => run.groupId === id));
  const runId = admin.recentRuns.find(run => run.groupId === id).id;
  assert(!('output' in admin.recentRuns[0]));
  assert(!('input' in admin.groups[0].runs[0]));
  assert.equal((await detailRoute.GET(request('/api/runs/' + runId, 'GET', undefined, false), { params: Promise.resolve({ id: runId }) })).status, 404);
  assert.equal((await detailRoute.GET(request('/api/runs/' + runId), { params: Promise.resolve({ id: runId }) })).status, 200);
  assert.equal(guestResponse.headers.get('Vary'), 'Cookie');
  const params = { params: Promise.resolve({ id }) };
  assert.equal((await groupRoute.PATCH(request('/api/admin/groups/' + id, 'PATCH', { ...payload, reasoningEffort: 'invalid' }), params)).status, 400);
  assert.equal((await groupRoute.PATCH(request('/api/admin/groups/' + id, 'PATCH', { ...payload, reasoningEffort: null, isPublic: true }), params)).status, 200);
  await runGroup(id);
  assert.equal(received.reasoning.effort, 'high');
  assert(getDashboardData().groups.some(group => group.id === id));
  for (const streaming of [false, true]) {
    await groupRoute.PATCH(request('/api/admin/groups/' + id, 'PATCH', { ...payload, streaming }), params);
    mode = 'stall';
    const started = Date.now();
    await runGroup(id);
    const run = db.prepare('SELECT * FROM runs WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(id);
    assert.equal(run.status, 'error');
    assert.equal(run.error, '请求超时（1 秒）');
    if (streaming) assert.equal(run.output, 'hello');
    assert(Date.now() - started < 4000);
  }
  for (const streaming of [false, true]) {
    await groupRoute.PATCH(request('/api/admin/groups/' + id, 'PATCH', { ...payload, streaming }), params);
    mode = streaming ? 'abrupt' : 'incomplete';
    await runGroup(id);
    const run = db.prepare('SELECT * FROM runs WHERE group_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
    assert.equal(run.status, 'incomplete');
    assert.equal(run.output, '21');
  }
  mode = 'complete-open';
  await runGroup(id);
  const complete = db.prepare('SELECT * FROM runs WHERE group_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
  assert.equal(complete.status, 'passed');
  assert.equal(complete.reasoning_summary, 'summary continued\n\nnext paragraph');
  const { formatReasoningSummary } = require('../lib/reasoning-summary.ts');
  assert.equal(formatReasoningSummary('**First****Second****Third**'), '**First**\n\n**Second**\n\n**Third**');
  assert.equal(formatReasoningSummary('**First**\n\n**Second**'), '**First**\n\n**Second**');
  assert.equal(formatReasoningSummary('Normal **bold** prose'), 'Normal **bold** prose');
  saveSettings({ timeoutSeconds: 5, maxConcurrentGroups: 1 });
  mode = 'stall';
  const second = await (await groups.POST(request('/api/admin/groups', 'POST', { ...payload, name: 'queued-group' }))).json();
  const before = requestCount;
  const [firstJob] = enqueueGroups([id]);
  const [duplicate] = enqueueGroups([id]);
  assert.equal(firstJob.id, duplicate.id);
  const [queuedJob] = enqueueGroups([second.id]);
  await waitUntil(() => requestCount > before);
  assert.equal(requestCount, before + 1);
  assert.equal(listJobs().find(j => j.id === queuedJob.id).status, 'queued');
  assert.equal((await runRoute.POST(request('/api/admin/run', 'POST', { groupId: id }))).status, 202);
  assert.equal(requestCount, before + 1);
  cancelJob(queuedJob.id);
  cancelJob(firstJob.id);
  await waitUntil(() => listJobs().find(j => j.id === firstJob.id).status === 'cancelled');
  assert.equal(listJobs().find(j => j.id === queuedJob.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM runs WHERE group_id = ? ORDER BY rowid DESC LIMIT 1').get(id).status, 'cancelled');
  assert.equal(requestCount, before + 1);
  const insert = db.prepare(`INSERT INTO runs (id, group_id, question_id, status, input, output, model, reasoning_effort, created_at) VALUES (?, ?, 'default-question', 'passed', 'test', '21', 'mock', 'high', ?)`);
  for (let i = 0; i < 60; i++) insert.run(`matrix-${i}`, id, new Date(Date.now() + i * 1000).toISOString());
  const matrix = getDashboardData(true).groups.find(group => group.id === id);
  assert.equal(matrix.runs.length, 36);
  assert.equal(matrix.runs[0].id, 'matrix-59');
  assert.equal(matrix.passRate, 100);
  assert.equal(getDashboardData(true, { limit: 24 }).groups.find(g => g.id === id).runs.length, 24);
  assert.equal(getDashboardData(true, { limit: 36 }).groups.find(g => g.id === id).runs.length, 36);
  assert(getDashboardData(true, { limit: 96 }).groups.find(g => g.id === id).runs.length > 48);
  const errors = getDashboardData(true, { errorsOnly: true }).groups.find(g => g.id === id);
  assert(errors.runs.every(r => ['failed', 'error', 'incomplete', 'interrupted'].includes(r.status)));
  assert.equal(errors.passRate, matrix.passRate);
  assert(getDashboardData(true, { effort: 'xhigh' }).groups.find(g => g.id === id).runs.every(r => r.reasoningEffort === 'xhigh'));
  assert.equal(getDashboardData(true, { model: 'missing-model' }).groups.length, 0);
  assert(!getDashboardData().groups.some(group => group.id === id));
  // Simulate a new process opening the persisted database after an interrupted task.
  db.prepare("INSERT INTO jobs (id, group_id, status, question_ids, total, created_at) VALUES ('orphan-job', ?, 'running', '[]', 1, ?)").run(id, new Date().toISOString());
  db.prepare("UPDATE runs SET status = 'running' WHERE id = 'matrix-0'").run();
  delete global.benchmarkWorker;
  assert.equal(listJobs().find(j => j.id === 'orphan-job').status, 'interrupted');
  assert.equal(db.prepare("SELECT status FROM runs WHERE id = 'matrix-0'").get().status, 'interrupted');
  console.log('PASS: configurable embed origin, config, permissions, lazy details, filtering, raw rates, Shanghai boundaries, effort overrides, partial output, incomplete responses, timeout, queue deduplication/concurrency/cancellation, restart recovery');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  upstream.closeAllConnections();
  upstream.close();
  db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});
