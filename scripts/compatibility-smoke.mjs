// Opt-in provider compatibility checks through the installed plugin. Every input
// is synthetic; only test-owned sessions are created, renamed and removed.
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {OpenCode} from '@opencode/client';
import {Service} from '@opencode/client/service';
import {SessionID} from '@opencode/schema/session-id';
import {AutoTitleStatusRpc} from '../src/status-rpc.mjs';
import {isCurrentTitleFormat} from '../src/naming.mjs';

const parseModel = value => {
  assert.match(value, /^[^/#]+\/[^/#]+(?:#[^/#]+)?$/);
  const [ref, variant] = value.split('#'), split = ref.indexOf('/');
  return {providerID: ref.slice(0, split), id: ref.slice(split + 1), ...(variant ? {variant} : {})};
};
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const root = process.platform === 'win32' && fs.existsSync('Z:/windows-tmp/opencode') ? 'Z:/windows-tmp/opencode' : tmpdir();
const location = {directory: path.resolve(process.env.AUTOTITLE_COMPAT_DIRECTORY ?? path.join(root, 'autotitle-compatibility-e2e'))};
const expectedPlugin = process.env.AUTOTITLE_COMPAT_PLUGIN_ID ?? 'local.session-autotitle';
const override = process.env.AUTOTITLE_COMPAT_OVERRIDE ? parseModel(process.env.AUTOTITLE_COMPAT_OVERRIDE) : undefined;
const reportFile = process.env.AUTOTITLE_COMPAT_REPORT ?? `artifacts/compatibility-smoke-v${version}.json`;
fs.mkdirSync(location.directory, {recursive: true});fs.mkdirSync(path.dirname(reportFile), {recursive: true});
const endpoint = await Service.discover();assert.ok(endpoint);
const client = OpenCode.make({baseUrl: endpoint.url, headers: Service.headers(endpoint)});
const created = new Set(), report = {version, rows: [], cleanup: [], ok: false};
const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
async function remove(sessionID) {
  await client.session.remove({sessionID});created.delete(sessionID);
  report.cleanup.push({sessionID, removed: true});
}
try {
  const warm = await client.session.create({location, title: '模型兼容性隔离验收', metadata: {'autotitle-compatibility-smoke': true}});
  created.add(warm.id);
  await client.session.command({sessionID: warm.id, name: 'autotitle-lock', text: ''});
  const plugin = (await client.plugin.list({location})).data.find(p => p.id === expectedPlugin);
  assert.equal(plugin?.state.status, 'active');report.plugin = plugin;
  const catalog = (await client.model.list({location})).data;
  const models = process.argv.slice(2).map(parseModel);
  if (!models.length) for (const model of catalog.filter(m => m.providerID === 'opencode'
      && m.cost.length && m.cost.every(t => t.input === 0 && t.output === 0))) {
    models.push({providerID: model.providerID, id: model.id, variant: model.variants.some(v => v.id === 'low') ? 'low' : 'default'});
  }
  assert.ok(models.length, 'No models selected');
  const template = await client.session.get({sessionID: warm.id});
  for (const model of models) {
    const sessionID = SessionID.create(), start = Date.now();
    const row = {model, ok: false};report.rows.push(row);write();
    try {
      await client.session.import({location, info: {...template, id: sessionID, model,
        title: '兼容性验收原始标题', time: {created: Date.now() - 10000, updated: Date.now()},
        outcome: 'succeeded', metadata: {'autotitle-compatibility-smoke': true}},
      messages: [{id: `msg_${randomBytes(13).toString('hex')}`, type: 'user', time: {created: Date.now()},
        text: '请修改操作日志的默认排序，按createTime倒序排序。'}]});
      created.add(sessionID);
      const before = await client.session.context({sessionID});
      let error;
      try {await client.session.command({sessionID, name: 'autotitle-refresh', text: ''}, {signal: AbortSignal.timeout(150000)});}
      catch (cause) {error = cause;}
      const status = await client.rpc(AutoTitleStatusRpc).read({sessionID}, {location});
      row.status = status.status;
      if (error) throw error;
      const after = await client.session.get({sessionID});row.title = after.title;
      assert.ok(isCurrentTitleFormat(after.title));assert.match(after.title, /createTime/);assert.match(after.title, /倒序|降序/);
      assert.deepEqual(after.model, model, 'naming must not switch the user session model');
      assert.deepEqual(await client.session.context({sessionID}), before);
      assert.deepEqual(status.status.lastModel, override ?? model);
      const selected = catalog.find(m => m.providerID === (override ?? model).providerID && m.id === (override ?? model).id);
      const expectedRoute = ['opencode', 'opencode-go'].includes(selected.providerID)
        && selected.cost.length && selected.cost.every(t => t.input === 0 && t.output === 0) ? 'session' : 'detached';
      assert.equal(status.status.lastGenerationRoute, expectedRoute);
      const children = await client.session.list({parentID: sessionID, limit: 20});
      assert.equal(children.data.length, 0, 'temporary override child must be removed');
      row.historyUnchanged = true;row.ok = true;
    } catch (error) {row.error = String(error.message).slice(0, 600);process.exitCode = 1;}
    finally {row.elapsedMs = Date.now() - start;if (created.has(sessionID)) await remove(sessionID);write();console.log(JSON.stringify(row));}
  }
  report.ok = report.rows.every(row => row.ok);
} catch (error) {report.error = String(error.message).slice(0, 600);process.exitCode = 1;}
finally {
  for (const sessionID of created) {
    try {await remove(sessionID);} catch {report.cleanup.push({sessionID, removed: false});report.ok = false;process.exitCode = 1;}
  }
  report.finishedAt = new Date().toISOString();write();
  console.log(JSON.stringify({ok: report.ok,rows: report.rows.length,reportFile,...(report.error ? {error: report.error} : {})}));
}
