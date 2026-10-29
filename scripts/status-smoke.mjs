// No model calls or prompts: disposable fixtures + real read-only status RPC.
// Runs the actual TUI command handler with a captured alert adapter, NOT a
// graphical assertion about the host's terminal renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {OpenCode} from '@opencode/client';
import {Service} from '@opencode/client/service';
import {AutoTitleStatusRpc} from '../src/status-rpc.mjs';
import tui from '../tui.js';
const endpoint = await Service.discover(); assert.ok(endpoint);
const client = OpenCode.make({baseUrl: endpoint.url, headers: Service.headers(endpoint)});
const temp = process.platform === 'win32' && fs.existsSync('Z:/windows-tmp/opencode')
  ? 'Z:/windows-tmp/opencode' : tmpdir();
const location = {directory: path.resolve(process.env.AUTOTITLE_SMOKE_DIRECTORY ?? path.join(temp, 'autotitle-status-e2e'))};
fs.mkdirSync(location.directory, {recursive: true}); fs.mkdirSync('artifacts', {recursive: true});
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const report = {version, checks: [], cleanup: [], ok: false};
const created = [];
const rpc = client.rpc(AutoTitleStatusRpc);
const read = sessionID => rpc.read({sessionID}, {location, signal: AbortSignal.timeout(10000)});
const check = name => {report.checks.push(name); console.log(JSON.stringify({check: name}));};
const create = async parentID => {
  const session = await client.session.create({title: '状态命令隔离验收', location,
    ...(parentID ? {parentID} : {}), metadata: {'autotitle-status-smoke': true},
    permissions: [{action: '*', resource: '*', effect: 'deny'}],
  });
  created.push(session.id); return session.id;
};
async function snapshot(sessionID) {
  return {info: await client.session.get({sessionID}), context: await client.session.context({sessionID})};
}
try {
  const id = await create();
  const first = await read(id); assert.equal(first.sessionID, id); assert.equal(first.status.locked, false);
  assert.match(first.message, /45 秒/); check('real_status_rpc_available');
  const before = await snapshot(id);
  const again = await read(id); assert.deepEqual(again, first);
  assert.deepEqual(await snapshot(id), before); check('repeat_read_preserves_session_and_history');
  await client.session.command({sessionID: id, name: 'autotitle-lock', text: ''});
  const lockedBefore = await snapshot(id), locked = await read(id);
  assert.equal(locked.status.locked, true); assert.equal(locked.status.reason, 'explicit_lock');
  assert.deepEqual(await snapshot(id), lockedBefore); check('locked_status_does_not_unlock_or_rename');
  let command, alert;
  const cleanup = tui.setup({client, location,
    data: {session: {get: () => lockedBefore.info}, location: {default: () => location}},
    keymap: {layer: factory => {command = factory().commands[0];}},
    ui: {router: {current: () => ({type: 'session', sessionID: id})},
      dialog: {alert: async value => {alert = value;}}, toast: {show: value => {throw new Error(value.message);}}},
  });
  assert.equal(command.slash.name, 'autotitle-status'); await command.run(); cleanup();
  assert.equal(alert?.message, locked.message); assert.deepEqual(await snapshot(id), lockedBefore);
  check('actual_tui_handler_calls_real_rpc_without_chat_writes');
  const child = await create(id), childBefore = await snapshot(child);
  const childStatus = await read(child); assert.equal(childStatus.status.managed, false);
  assert.deepEqual(await snapshot(child), childBefore); check('excluded_child_can_read_status');
  assert.equal((await client.session.context({sessionID: id})).length, 0);
  check('no_prompt_or_model_turn_created'); report.ok = true;
} catch (error) {report.error = String(error.message).slice(0, 600); process.exitCode = 1;}
finally {
  for (const sessionID of created.reverse()) {
    try {await client.session.remove({sessionID}); report.cleanup.push({sessionID, removed: true});}
    catch {report.cleanup.push({sessionID, removed: false}); report.ok = false; process.exitCode = 1;}
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(`artifacts/status-smoke-v${version}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
