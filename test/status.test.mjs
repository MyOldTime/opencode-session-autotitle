import test from 'node:test';
import assert from 'node:assert/strict';
import server from '../index.js';
import tui from '../tui.js';
import {AutoTitleController} from '../src/controller.mjs';
import {AutoTitleStatusRpc} from '../src/status-rpc.mjs';
import {formatStatus} from '../src/status-display.mjs';

const clone = value => structuredClone(value);
const id = 'ses_status_fixture';
const location = {directory: process.cwd()};
const stored = () => ({schema: 1, mode: 'locked', reason: 'explicit_lock', tasks: [],
  lastOutcome: 'cancelled_or_timeout', lastAttemptAt: 1793252200000,
  model: {providerID: 'deepseek', id: 'deepseek-flash', variant: 'max'}, pending: null});
const forbidden = () => { throw new Error('Read-only boundary violated'); };

test('status reads fresh snapshots without creating machines, storage writes, history or scheduling', async () => {
  for (const variant of ['untracked', 'locked', 'busy', 'child', 'archived', 'legacy_fork']) {
    const value = variant === 'untracked' ? undefined : stored();
    const info = {id, location, title: '不应改名', time: {},
      ...(variant === 'child' ? {parentID: 'ses_parent'} : {}),
      ...(variant === 'busy' ? {executing: true} : {}),
    };
    if (variant === 'archived') info.time.archived = 1;
    if (variant === 'legacy_fork') {info.fork = {}; value.reason = 'fork_not_adopted';}
    const initial = clone(value);
    const ctl = new AutoTitleController({options: {}, location,
      storage: {get: async () => value, set: forbidden, remove: forbidden},
      session: {get: async () => info, update: forbidden, context: forbidden, prompt: forbidden, synthetic: forbidden},
      experimental: {generate: {text: forbidden}},
    });
    ctl.schedule = forbidden;
    const first = await ctl.status(id);
    const second = await ctl.status(id);
    assert.deepEqual(first, second);
    assert.equal(ctl.machines.size, 0, variant);
    assert.deepEqual(value, initial, variant);
    assert.equal(first.tracked, variant !== 'untracked');
    assert.equal(first.managed, !['child', 'archived', 'legacy_fork'].includes(variant));
    if (variant === 'legacy_fork') assert.equal(first.locked, false);
    if (first.tracked) {
      assert.equal(first.generationAttempts, 0);
      assert.equal(first.generationMaxAttempts, 0);
      assert.equal(first.lastGenerationFailure, null);
    } else {
      assert.equal('generationAttempts' in first, false);
      assert.equal('lastGenerationFailure' in first, false);
    }
    if (first.lastModel) first.lastModel.id = 'caller mutation';
    assert.deepEqual(value, initial, 'snapshot must not alias storage');
  }
});

test('status during generation does not cancel, replace state or reschedule work', async () => {
  const ctl = new AutoTitleController({options: {}, location,
    session: {get: async () => ({id, location, time: {}})}, storage: {get: forbidden, set: forbidden},
  });
  const m = ctl.machine(id); m.loaded = true; m.state = {...stored(), mode: 'auto', lastOutcome: 'generating'};
  m.busy = true; m.epoch = 7; m.generation = new AbortController(); m.timer = {sentinel: true};
  const before = clone(m.state), timer = m.timer;
  const result = await ctl.status(id);
  assert.equal(result.lastOutcome, 'generating');
  assert.equal(m.generation.signal.aborted, false); assert.equal(m.timer, timer); assert.equal(m.epoch, 7);
  assert.deepEqual(m.state, before);
});

test('status rejects mismatched locations before reading another location storage', async () => {
  const ctl = new AutoTitleController({options: {}, location,
    session: {get: async () => ({id, location: {directory: 'Z:/different-location'}})},
    storage: {get: forbidden},
  });
  await assert.rejects(ctl.status(id), /不属于当前 location/);
});

test('server registers disposable read-only RPC and retains tool compatibility', async () => {
  let implementation, contract, disposed = false;
  const tools = new Map(), commands = new Map();
  const ctx = {options: {timeoutMs: 45000}, location,
    storage: {get: async key => key === 'meta/installed-at' ? 1 : stored(), set: forbidden,
      scan: async () => ({entries: []})},
    session: {get: async () => ({id, location, time: {}}), hook: async () => ({dispose: async () => {}})},
    command: {transform: async fn => {fn({add: command => commands.set(command.name, command)}); return {dispose: async () => {}};}},
    tool: {transform: async fn => {fn({add: tool => tools.set(tool.name, tool)}); return {dispose: async () => {}};}},
    event: {subscribe: async function* () {}},
    rpc: {register: async (definition, impl) => {contract = definition; implementation = impl; return {dispose: async () => {disposed = true;}};}},
  };
  const cleanup = await server.setup(ctx);
  try {
    assert.equal(contract, AutoTitleStatusRpc);
    assert.deepEqual(contract.events, {});
    assert.deepEqual(contract.methods.read.errors, {});
    assert.equal('pattern' in contract.methods.read.input.properties.sessionID, false);
    await assert.rejects(implementation.read({sessionID: '../invalid'}), /无效的会话 ID/);
    const result = await implementation.read({sessionID: id});
    const tool = JSON.parse((await tools.get('autotitle_status').execute({}, {sessionID: id})).content);
    assert.deepEqual(JSON.parse(JSON.stringify(result.status)), tool);
    assert.match(result.message, /deepseek\/deepseek-flash #max/);
    assert.match(result.message, /45 秒/);
    assert.equal(commands.has('autotitle-status'), false, 'no silent server command pretending to display text');
  } finally { await cleanup(); }
  assert.equal(disposed, true);
});

test('display explains states, preserves unknown codes, and sanitizes terminal controls', () => {
  for (const code of ['not_evaluated', 'locked', 'generating', 'cancelled_or_timeout', 'model_failed', 'invalid_unknown_field', 'future_code', 'toString']) {
    const message = formatStatus({...stored(), tracked: true, managed: true, locked: true, lastOutcome: code}, {sessionID: id, timeoutMs: 45000});
    assert.ok(message.includes(code)); assert.match(message, /只读查询/); assert.match(message, /最近评估时间（UTC）/);
  }
  const message = formatStatus({...stored(), lastModel: {providerID: 'x\u001b[2J', id: 'y\nsecret', variant: 'max\u202e'}}, {sessionID: id, timeoutMs: 45000});
  assert.doesNotMatch(message, /\u001b|\u202e/); assert.doesNotMatch(message, /y\nsecret/);
});

test('display reports generation attempts, limit and a sanitized failure code', () => {
  const message = formatStatus({...stored(), tracked: true, managed: true,
    generationAttempts: 2, generationMaxAttempts: 3, lastGenerationFailure: 'generation_timeout'},
  {sessionID: id, timeoutMs: 45000});
  assert.match(message, /本轮生成尝试：2\/3/);
  assert.match(message, /最近生成失败：模型请求超时/);
  assert.match(message, /generation_timeout/);
  const unsafe = formatStatus({...stored(), tracked: true, managed: true,
    generationAttempts: 2, generationMaxAttempts: 3, lastGenerationFailure: 'generation_timeout\u001b[2J'},
  {sessionID: id, timeoutMs: 45000});
  assert.doesNotMatch(unsafe, /\u001b/);
  const legacy = formatStatus({...stored(), tracked: true, managed: true}, {sessionID: id, timeoutMs: 45000});
  assert.match(legacy, /本轮生成尝试：尚无记录/);
  assert.doesNotMatch(legacy, /最近生成失败/);
});

test('display explains the catalog-selected generation route and normal ownership reasons', () => {
  for (const [route, label] of [['session', '宿主会话瞬时生成'], ['detached', '宿主独立生成']]) {
    const message = formatStatus({...stored(), reason: 'new_session', lastGenerationRoute: route}, {sessionID: id, timeoutMs: 45000});
    assert.ok(message.includes(label));assert.match(message, /新会话自动管理/);assert.doesNotMatch(message, /未识别状态/);
  }
});

function uiHarness() {
  let command, route = {type: 'session', sessionID: id};
  const calls = [], alerts = [], toasts = [];
  let read = async () => ({message: '只读状态', sessionID: id, status: {}});
  const ctx = {
    location: {directory: 'Z:/fallback'},
    keymap: {layer: factory => {command = factory().commands[0];}},
    ui: {router: {current: () => route}, dialog: {alert: async value => {alerts.push(value);}}, toast: {show: value => toasts.push(value)}},
    data: {session: {get: () => ({location})}, location: {default: () => location}},
    client: {rpc: definition => {assert.equal(definition, AutoTitleStatusRpc);return {read: async (...args) => {calls.push(args);return read(...args);}};}},
  };
  const cleanup = tui.setup(ctx);
  return {command, calls, alerts, toasts, cleanup, setRoute: value => {route = value;}, setRead: fn => {read = fn;}};
}

test('TUI slash command reads selected session via location-scoped RPC and shows alert', async () => {
  const h = uiHarness();
  assert.equal(h.command.slash.name, 'autotitle-status'); assert.equal(h.command.palette, true);
  await h.command.run();
  assert.deepEqual(h.calls[0][0], {sessionID: id}); assert.deepEqual(h.calls[0][1].location, location);
  assert.ok(h.calls[0][1].signal instanceof AbortSignal);
  assert.deepEqual(h.alerts, [{title: '自动命名状态（只读）', message: '只读状态'}]);
  assert.equal(h.toasts.length, 0);
});

test('TUI homepage does not make requests and RPC failures do not leak raw errors', async () => {
  const h = uiHarness(); h.setRoute({type: 'home'}); await h.command.run();
  assert.equal(h.calls.length, 0); assert.equal(h.toasts[0].variant, 'info');
  h.setRoute({type: 'session', sessionID: id});
  h.setRead(async () => {throw new Error('private credential and URL');}); await h.command.run();
  assert.equal(h.alerts.length, 0); assert.equal(h.toasts.at(-1).variant, 'error');
  assert.doesNotMatch(JSON.stringify(h.toasts), /private credential/);
});

test('TUI suppresses duplicate requests and stale dialogs after navigation or unload', async () => {
  for (const action of ['navigate', 'dispose']) {
    const h = uiHarness(); let finish;
    h.setRead(() => new Promise(resolve => {finish = resolve;}));
    const pending = h.command.run(); await h.command.run(); assert.equal(h.calls.length, 1);
    if (action === 'navigate') h.setRoute({type: 'session', sessionID: 'ses_elsewhere'}); else h.cleanup();
    finish({message: 'stale response'}); await pending;
    assert.equal(h.alerts.length, 0); assert.equal(h.toasts.length, 0);
  }
});
