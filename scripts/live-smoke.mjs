// Creates and deletes only tagged disposable sessions. No existing chat is read,
// renamed, interrupted or deleted. Requires the globally installed plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { isCurrentTitleFormat } from '../src/naming.mjs';
import { AutoTitleStatusRpc } from '../src/status-rpc.mjs';

const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const reportPath = `artifacts/live-smoke-v${version}.json`;
const rawModel = process.env.AUTOTITLE_SMOKE_MODEL;
const model = rawModel ? (() => {
  assert.match(rawModel, /^[^/#]+\/[^/#]+(?:#[^/#]+)?$/, 'AUTOTITLE_SMOKE_MODEL must be provider/model#variant');
  const [ref, variant] = rawModel.split('#');
  const split = ref.indexOf('/');
  return {providerID: ref.slice(0, split), id: ref.slice(split + 1), ...(variant ? {variant} : {})};
})() : undefined;

const endpoint = await Service.discover();
assert.ok(endpoint, 'OpenCode service not available');
const client = OpenCode.make({baseUrl: endpoint.url, headers: Service.headers(endpoint)});
const temp = process.platform === 'win32' && fs.existsSync('Z:/windows-tmp/opencode')
  ? 'Z:/windows-tmp/opencode' : tmpdir();
const directory = path.resolve(process.env.AUTOTITLE_SMOKE_DIRECTORY ?? path.join(temp, 'autotitle-e2e'));
fs.mkdirSync(directory, {recursive: true});
fs.mkdirSync('artifacts', {recursive: true});
const created = new Set();
const observed = [];
const waiters = new Set();
const stop = new AbortController();
const report = {version, startedAt: new Date().toISOString(), directory, checks: [], sessions: [], cleanup: []};
const record = (check, details = {}) => {
  const result = {check, ...details}; report.checks.push(result);
  console.log(JSON.stringify(result));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
};
function waitEvent(predicate, timeout = 90000, after = 0) {
  const found = observed.slice(after).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const waiter = {predicate, resolve: (event) => {clearTimeout(timer); waiters.delete(waiter); resolve(event);}};
    const timer = setTimeout(() => {waiters.delete(waiter); reject(new Error('Expected event deadline exceeded'));}, timeout);
    waiters.add(waiter);
  });
}
const stream = (async () => {
  try {
    for await (const event of client.event.subscribe({types: [
      'session.renamed', 'session.idle', 'session.execution.started', 'session.execution.succeeded',
      'session.execution.failed', 'session.tool.called',
    ], signal: stop.signal})) {
      if (event.type !== 'server.connected' && !created.has(event.data?.sessionID)) continue;
      observed.push(event);
      for (const w of [...waiters]) if (w.predicate(event)) w.resolve(event);
    }
  } catch { if (!stop.signal.aborted) record('event_stream_error'); }
})();
const create = async (title, parentID) => {
  const info = await client.session.create({
    location: {directory}, ...(title ? {title} : {}), ...(parentID ? {parentID} : {}),
    agent: 'build', ...(model ? {model} : {}),
    metadata: {'autotitle-smoke': true}, permissions: [{action: '*', resource: '*', effect: 'deny'}],
  });
  created.add(info.id); report.sessions.push(info.id);
  return info.id;
};
const command = (sessionID, name) => client.session.command({sessionID, name, text: ''}, {signal: AbortSignal.timeout(150000)});
const importFixture = async (template, title, messages) => {
  const id = `ses_${randomBytes(13).toString('hex')}`;
  // All imported content below is synthetic. No actual conversation is copied.
  const info = await client.session.import({
    info: {...template, id, title, time: {created: Date.now() - 86400000, updated: Date.now()},
      metadata: {'autotitle-smoke': true}, outcome: 'succeeded'}, messages, location: {directory},
  });
  created.add(info.id); report.sessions.push(info.id);
  return info.id;
};
try {
  await waitEvent(e => e.type === 'server.connected', 10000);
  const old = await create('验收专用原有标题');
  // Prompt admission waits for this location's plugins to activate. resume:false
  // warms only the registry; the input stays in the inbox, NOT session.context.
  // It does not invoke a model or execute any tools.
  await client.session.prompt({sessionID: old, text: '隔离验收的插件加载检查，不执行任何工作。', resume: false});
  const plugins = await client.plugin.list({location: {directory}});
  const plugin = plugins.data.find(x => x.id === 'myoldtime.session-autotitle');
  assert.equal(plugin?.state.status, 'active');
  record('global_plugin_active', {id: plugin.id});
  const commands = await client.command.list({location: {directory}});
  for (const name of ['autotitle-lock', 'autotitle-unlock', 'autotitle-refresh']) assert.ok(commands.data.some(x => x.name === name));
  record('commands_registered');

  const template = await client.session.get({sessionID: old});
  const imported = await importFixture(template, '操作日志｜修改按排序字段createTime倒序排序', [{
    id: `msg_${randomBytes(13).toString('hex')}`, type: 'user',
    text: '请修改操作日志的默认排序：按排序字段createTime倒序排序。', time: {created: Date.now()},
  }]);
  await command(imported, 'autotitle-refresh');
  const migratedTitle = (await client.session.get({sessionID: imported})).title;
  assert.ok(isCurrentTitleFormat(migratedTitle));
  assert.match(migratedTitle, /createTime/); assert.match(migratedTitle, /倒序|降序/);
  record('old_named_session_refreshes_without_unlock', {title: migratedTitle});

  const secondRequest = '第一项操作日志排序已完成。另一个独立任务：修复登录接口收到401后刷新Token并重试原请求。两个任务都要保留在标题中。这是隔离验收，请只回复“收到第二项任务”，不要调用工具或读写文件。';
  // A queued resume:false input is not naming context. Let one real turn
  // consume the synthetic input before testing incremental title evaluation.
  await client.session.prompt({sessionID: imported, text: secondRequest});
  await client.session.wait({sessionID: imported}, {signal: AbortSignal.timeout(120000)});
  const secondContext = await client.session.context({sessionID: imported});
  assert.ok(secondContext.some(m => m.type === 'user' && m.text === secondRequest));
  assert.equal(observed.filter(e => e.type === 'session.tool.called' && e.data.sessionID === imported).length, 0);
  record('new_task_input_delivered_before_refresh');
  await command(imported, 'autotitle-refresh');
  const dualTitle = (await client.session.get({sessionID: imported})).title;
  assert.ok(isCurrentTitleFormat(dualTitle));
  for (const pattern of [/操作日志/, /createTime/, /倒序|降序/, / \| /, /登录接口/, /401/, /Token/, /重试/]) assert.match(dualTitle, pattern);
  assert.doesNotMatch(dualTitle, /已完成/);
  record('completed_task_and_new_independent_task_retained', {title: dualTitle});

  const compacted = await importFixture(template, '验收专用压缩后的旧名称', [{
    id: `msg_${randomBytes(13).toString('hex')}`, type: 'compaction', status: 'completed', reason: 'auto',
    summary: '用户的核心需求是设计 OpenCode 会话自动命名插件方案，只做设计，不实现代码。', time: {created: Date.now()},
  }]);
  const compactedContext = await client.session.context({sessionID: compacted});
  assert.equal(compactedContext.filter(m => m.type === 'user').length, 0);
  assert.ok(compactedContext.some(m => m.type === 'compaction' && m.status === 'completed'));
  await command(compacted, 'autotitle-refresh');
  const compactedTitle = (await client.session.get({sessionID: compacted})).title;
  assert.ok(isCurrentTitleFormat(compactedTitle)); assert.match(compactedTitle, /设计/);
  record('compaction_only_session_refreshes_without_unlock', {title: compactedTitle});
  assert.deepEqual((await client.session.context({sessionID: compacted})).map(m => m.id), compactedContext.map(m => m.id));
  record('compaction_refresh_preserves_history');

  const empty = await create('验收专用无上下文会话');
  await assert.rejects(command(empty, 'autotitle-refresh'), /no_context/);
  assert.equal((await client.session.get({sessionID: empty})).title, '验收专用无上下文会话');
  record('empty_context_has_specific_reason_not_locked');

  const sessionID = await create();
  const start = Date.now();
  await client.session.prompt({sessionID, text: '这是自动命名插件的隔离验收样例：本会话主题是设计 OpenCode 会话自动命名插件方案，只需要设计、不实现代码。请只回复“收到方案设计请求”，不要调用任何工具、不要读写文件。'});
  await client.session.wait({sessionID}, {signal: AbortSignal.timeout(120000)});
  await waitEvent(e => e.type === 'session.renamed' && e.data.sessionID === sessionID && isCurrentTitleFormat(e.data.title), 150000);
  let info = await client.session.get({sessionID});
  assert.ok(isCurrentTitleFormat(info.title)); assert.match(info.title, /设计/);
  record('automatic_title_written', {title: info.title, elapsedMs: Date.now() - start});
  assert.equal(observed.filter(e => e.type === 'session.tool.called' && e.data.sessionID === sessionID).length, 0);

  const before = await client.session.context({sessionID});
  await command(sessionID, 'autotitle-lock');
  await assert.rejects(command(sessionID, 'autotitle-refresh'));
  record('explicit_lock_blocks_refresh');
  await command(sessionID, 'autotitle-unlock');
  await command(sessionID, 'autotitle-refresh');
  record('command_lock_can_unlock_and_refresh');
  await client.session.update({sessionID, title: '验收专用人工名称'});
  await command(sessionID, 'autotitle-unlock');
  assert.equal((await client.session.get({sessionID})).title, '验收专用人工名称');
  record('unlock_keeps_current_title');
  await client.session.update({sessionID, title: '验收专用人工名称（再次修改）'});
  await assert.rejects(command(sessionID, 'autotitle-refresh'));
  assert.equal((await client.session.get({sessionID})).title, '验收专用人工名称（再次修改）');
  record('manual_rename_auto_locks');
  await command(sessionID, 'autotitle-unlock');
  await command(sessionID, 'autotitle-refresh');
  info = await client.session.get({sessionID});
  assert.ok(isCurrentTitleFormat(info.title));
  record('explicit_unlock_refresh_renames', {title: info.title});
  const after = await client.session.context({sessionID});
  assert.deepEqual(after.map(x => x.id), before.map(x => x.id));
  record('commands_do_not_pollute_history');
  const child = await create('验收专用子会话', sessionID);
  await assert.rejects(command(child, 'autotitle-unlock'));
  record('child_session_excluded');

  // Deterministic request failure through the installed plugin and real host.
  // This synthetic fixture names a nonexistent provider, so no remote request
  // or credential is required for the failure case. Existing sessions/config
  // are untouched; timeout/late-result branches are covered by unit tests.
  const failedID = await importFixture({...template,
    model: {providerID: 'autotitle-smoke-missing-provider', id: 'missing-model'},
  }, '验收专用生成失败标题', [{
    id: `msg_${randomBytes(13).toString('hex')}`, type: 'user',
    text: '请修复登录接口收到401后刷新Token并重试原请求。', time: {created: Date.now()},
  }]);
  const failedBefore = await client.session.context({sessionID: failedID});
  const failedStart = Date.now();
  await assert.rejects(command(failedID, 'autotitle-refresh'), /model_failed/);
  const failedElapsedMs = Date.now() - failedStart;
  const failedStatus = await client.rpc(AutoTitleStatusRpc).read({sessionID: failedID}, {
    location: {directory}, signal: AbortSignal.timeout(10000),
  });
  assert.equal(failedStatus.status.generationAttempts, 3);
  assert.equal(failedStatus.status.generationMaxAttempts, 3);
  assert.equal(failedStatus.status.lastOutcome, 'model_failed');
  assert.equal(failedStatus.status.lastGenerationFailure, 'model_failed');
  assert.equal(failedStatus.status.lastTrigger, 'manual');
  assert.ok(failedElapsedMs >= 2900, 'real 1s + 2s backoff must run');
  assert.match(failedStatus.message, /本轮生成尝试：3\/3/);
  record('request_failure_retries_exactly_twice', {attempts: 3, failedElapsedMs});
  assert.equal((await client.session.get({sessionID: failedID})).title, '验收专用生成失败标题');
  assert.deepEqual(await client.session.context({sessionID: failedID}), failedBefore);
  record('failed_generation_preserves_title_and_history');
  report.ok = true;
} catch (error) {
  report.ok = false;
  record('failed', {message: error.message});
  process.exitCode = 1;
} finally {
  for (const sessionID of [...created].reverse()) {
    try { await client.session.remove({sessionID}); report.cleanup.push({sessionID, removed: true}); }
    catch { report.cleanup.push({sessionID, removed: false}); report.ok = false; process.exitCode = 1; }
  }
  stop.abort(); await stream;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ok: report.ok, cleanup: report.cleanup, reportPath}));
}
