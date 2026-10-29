import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AutoTitleController, normalizeMessages, latestCompaction, selectNamingModel } from '../src/controller.mjs';

const copy = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
const answer = (subject = '登录接口', target = '刷新失败') => JSON.stringify({
  action: 'rename', reasonCode: 'initial_request', tasks: [{id: 't1', subject, verb: '修复', target}],
});
const user = (id, text = '请修复登录接口刷新失败的问题') => ({id, type: 'user', text, time: {created: Date.now()}});
const assistant = (id = 'a1') => ({id, type: 'assistant', content: [
  {type: 'reasoning', text: 'PRIVATE_REASONING'}, {type: 'tool', text: 'PRIVATE_TOOL'},
  {type: 'text', text: '已经定位刷新路径的问题。'},
]});

// The real OpenCode server keeps an event loop alive; an isolated Node 22 test
// process does not. Supply a bounded host lifetime when testing unref'ed timers.
async function awaitHostWork(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Host work did not finish within 5 seconds')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function harness({store = new Map(), options = {}, session = {}, sleep} = {}) {
  const sessions = new Map();
  const contexts = new Map();
  const commands = new Map();
  const hooks = new Map();
  const calls = [];
  const writes = [];
  let generation = async () => ({text: answer()});
  let ctl;
  const ctx = {
    options: {debounceMs: 10, cooldownMs: 60, ...options},
    location: {directory: process.cwd()},
    storage: {
      get: async key => copy(store.get(key)),
      set: async (key, value) => { store.set(key, copy(value)); },
      remove: async key => store.delete(key),
      scan: async ({prefix}) => ({entries: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({key, value: copy(value)}))}),
    },
    session: {
      get: async ({sessionID}) => { if (!sessions.has(sessionID)) throw new Error('not found'); return copy(sessions.get(sessionID)); },
      context: async ({sessionID}) => copy(contexts.get(sessionID) ?? []),
      update: async ({sessionID, title}) => {
        sessions.get(sessionID).title = title;
        writes.push({sessionID, title});
        void ctl.handleEvent({type: 'session.renamed', data: {sessionID, title}});
      },
      hook: async (name, fn) => {hooks.set(name, fn);return {dispose: async () => hooks.delete(name)};},
      generate: async ({sessionID, prompt}, opts) => {
        const model = sessions.get(sessionID).model;
        const event = {sessionID, model, system: [{type: 'text', text: 'host'}], tools: {read: {}},
          messages: [{role: 'user', content: [{type: 'text', text: prompt}]}]};
        await hooks.get('generate')(event);
        const input = {prompt: event.messages[0].content[0].text, model};
        calls.push(input);return generation(input, opts);
      },
      wait: async ({sessionID}) => { if (sessions.get(sessionID)?.executing) throw new Error('busy'); },
    },
    command: {transform: async fn => { fn({add: item => commands.set(item.name, item)}); return {dispose: async () => {}}; }},
    experimental: {generate: {text: async (input, opts) => { calls.push(input); return generation(input, opts); }}},
  };
  const s = {id: 's1', location: ctx.location, time: {created: Date.now() + 10, updated: Date.now()}, ...session};
  sessions.set('s1', s);
  contexts.set('s1', [user('u1')]);
  ctl = new AutoTitleController(ctx, {log: () => {}, ...(sleep === null ? {} : {sleep: sleep ?? (async () => {})})});
  await ctl.start({subscribe: false});
  const emit = (type, data = {}) => ctl.handleEvent({type, data: {sessionID: 's1', ...data}});
  return {ctl, ctx, store, sessions, contexts, commands, calls, writes, emit,
    setGeneration: fn => {generation = fn;}, create: () => emit('session.created')};
}

test('V2 message adaptation excludes tools, reasoning and synthetic/system content', () => {
  const result = normalizeMessages([user('u1'), assistant(), {id: 'x', type: 'synthetic', text: 'internal'}]);
  assert.equal(result.length, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('internal'), false);
});

test('named root sessions are unlocked by default and refresh needs no prior unlock', async t => {
  const h = await harness({session: {title: '原有标题'}}); t.after(() => h.ctl.dispose());
  assert.deepEqual(await h.ctl.status('s1'), {
    managed: true, tracked: false, mode: 'auto', locked: false,
    reason: 'default_unlocked', lastOutcome: 'not_evaluated',
  });
  assert.equal(h.store.has('sessions/s1'), false, 'status must not create a record');
  await h.create();
  assert.equal((await h.ctl.status('s1')).locked, false);
  assert.equal(h.calls.length, 0, 'observing/creating a title must not generate');
  assert.equal(h.store.get('sessions/s1').baselineTitle, '原有标题');
  await h.ctl.command('refresh', 's1');
  assert.equal(h.sessions.get('s1').title, '[登录接口](修复)刷新失败');
});

test('old untracked session is lazily adopted on activity, not treated as locked', async t => {
  const h = await harness({session: {title: '旧的自动标题', time: {created: 1}}}); t.after(() => h.ctl.dispose());
  await h.emit('session.idle');
  await delay(30); await h.ctl.machine('s1').flight;
  assert.equal(h.calls.length, 1);
  assert.equal((await h.ctl.status('s1')).locked, false);
});

test('an actual rename on a previously untracked session creates the shared lock', async t => {
  const h = await harness({session: {title: '旧标题'}}); t.after(() => h.ctl.dispose());
  h.sessions.get('s1').title = '用户新标题';
  await h.emit('session.renamed', {title: '用户新标题'});
  assert.equal((await h.ctl.status('s1')).locked, true);
  assert.equal(h.store.get('sessions/s1').reason, 'external_rename');
  await assert.rejects(h.ctl.command('refresh', 's1'), /共用此锁/);
  await h.ctl.command('unlock', 's1');
  assert.equal((await h.ctl.status('s1')).locked, false);
  assert.equal(h.sessions.get('s1').title, '用户新标题');
  await h.ctl.command('refresh', 's1');
  assert.equal(h.writes.length, 1);
});

test('manual rename and explicit lock share one persistent state and both unlock after reload', async () => {
  for (const origin of ['rename', 'command']) {
    const h = await harness({session: {title: '原始名称'}});
    await h.create();
    if (origin === 'rename') {
      h.sessions.get('s1').title = '人工名称';
      await h.emit('session.renamed', {title: '人工名称'});
    } else await h.ctl.command('lock', 's1');
    const title = h.sessions.get('s1').title;
    await h.ctl.dispose();
    const next = await harness({store: h.store, session: {title}});
    try {
      assert.equal((await next.ctl.status('s1')).locked, true);
      await next.ctl.command('unlock', 's1');
      assert.equal((await next.ctl.status('s1')).locked, false);
      assert.equal(next.sessions.get('s1').title, title);
      assert.equal(next.calls.length, 0);
      await next.ctl.command('refresh', 's1');
      assert.equal(next.writes.length, 1);
      assert.equal([...next.store.keys()].filter(k => k.startsWith('sessions/')).length, 1);
    } finally { await next.ctl.dispose(); }
  }
});

test('unlock followed by plugin reload does not itself schedule a rename', async () => {
  const h = await harness({session: {title: '旧名称'}});
  await h.ctl.command('unlock', 's1'); await h.ctl.dispose();
  const next = await harness({store: h.store, session: {title: '旧名称'}});
  try {
    await delay(35);
    assert.equal(next.calls.length, 0);
    assert.equal((await next.ctl.status('s1')).locked, false);
  } finally { await next.ctl.dispose(); }
});

test('scope exclusion is not a lock and legacy fork-exclusion lock is migrated', async t => {
  const h = await harness({session: {fork: {sessionID: 'source'}, title: '继承标题'}});
  t.after(() => h.ctl.dispose());
  const status = await h.ctl.status('s1');
  assert.equal(status.managed, false); assert.equal(status.locked, false);
  await h.ctl.command('unlock', 's1');
  const state = h.store.get('sessions/s1');
  state.mode = 'locked'; state.reason = 'fork_not_adopted'; delete state.forkAdopted;
  h.store.set('sessions/s1', state); await h.ctl.dispose();
  const next = await harness({store: h.store, session: {fork: {sessionID: 'source'}, title: '继承标题'}});
  t.after(() => next.ctl.dispose());
  assert.equal((await next.ctl.status('s1')).locked, false);
  assert.equal((await next.ctl.status('s1')).managed, false);
  await next.ctl.command('unlock', 's1');
  await next.ctl.command('refresh', 's1');
  assert.equal(next.writes.length, 1);
});

const compacted = (id = 'c1', summary = '用户要求修复登录接口刷新失败；会话只做这一项任务。') => ({
  id, type: 'compaction', status: 'completed', summary, reason: 'auto', time: {created: Date.now()},
});

test('completed compaction is historical context but never a user turn', () => {
  const messages = [compacted(), {id: 'c2', type: 'compaction', status: 'failed', summary: '失败摘要'},
    {id: 'c3', type: 'compaction', status: 'running', summary: '未完成摘要'}];
  assert.equal(latestCompaction(messages).id, 'c1');
  assert.deepEqual(normalizeMessages(messages), []);
});

test('compaction-only old session can refresh with no prior unlock or user messages', async t => {
  const h = await harness({session: {title: '压缩后的旧标题'}}); t.after(() => h.ctl.dispose());
  h.contexts.set('s1', [compacted(), assistant()]);
  await h.ctl.command('refresh', 's1');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /历史压缩摘要/);
  assert.match(h.calls[0].prompt, /用户要求修复登录接口刷新失败/);
  assert.equal(h.sessions.get('s1').title, '[登录接口](修复)刷新失败');
  const s = h.store.get('sessions/s1');
  assert.deepEqual(s.evaluatedUserIDs, []);
  assert.equal(s.anchor, null);
  assert.deepEqual(s.contextSources, ['compaction']);
  assert.equal(JSON.stringify(s).includes('会话只做这一项任务'), false, 'do not persist raw summary');
});

test('new compaction does not count toward the four-user-turn threshold', async t => {
  const h = await harness({options: {cooldownMs: 0}}); t.after(() => h.ctl.dispose());
  h.contexts.set('s1', [compacted(), assistant()]);
  await h.ctl.command('refresh', 's1');
  h.contexts.set('s1', [compacted('c2'), assistant()]);
  const outcome = await h.ctl.evaluate('s1');
  assert.equal(outcome.outcome, 'below_threshold');
  assert.equal(h.calls.length, 1);
});

test('summary and fresh user correction are both passed to the naming prompt', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  h.contexts.set('s1', [compacted(), user('u2', '纠正：只设计验证方案，不直接修改接口代码。')]);
  await h.ctl.command('refresh', 's1');
  assert.match(h.calls[0].prompt, /用户要求修复登录接口/);
  assert.match(h.calls[0].prompt, /只设计验证方案/);
  assert.deepEqual(h.store.get('sessions/s1').evaluatedUserIDs, ['u2']);
});

test('stored anchor and task ledger can refresh after visible user context disappears', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  await h.ctl.command('refresh', 's1');
  h.contexts.set('s1', [assistant()]);
  h.setGeneration(async () => ({text: JSON.stringify({action: 'keep', reasonCode: 'no_change'})}));
  await h.ctl.command('refresh', 's1');
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].prompt, /请修复登录接口/);
  assert.deepEqual(h.store.get('sessions/s1').contextSources, ['anchor', 'tasks']);
});

test('empty context reports a specific reason without calling a model or locking', async t => {
  const h = await harness({session: {title: '空会话'}}); t.after(() => h.ctl.dispose());
  h.contexts.set('s1', [assistant(), {id: 'synth', type: 'synthetic', text: '不要作为需求'}]);
  await assert.rejects(h.ctl.command('refresh', 's1'), /没有可用于命名.*no_context/);
  assert.equal(h.calls.length, 0);
  const status = await h.ctl.status('s1');
  assert.equal(status.lastOutcome, 'no_context'); assert.equal(status.locked, false);
  assert.equal(h.sessions.get('s1').title, '空会话');
});

test('a changed compaction snapshot invalidates an in-flight candidate', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  h.contexts.set('s1', [compacted()]);
  h.setGeneration(async () => {h.contexts.set('s1', [compacted('c2', '用户改为设计邮件服务')]); return {text: answer()};});
  await assert.rejects(h.ctl.command('refresh', 's1'), /上下文发生变化.*stale/);
  assert.equal(h.writes.length, 0);
});

test('child, fork, archived and foreign-location sessions are excluded', async () => {
  for (const session of [
    {parentID: 'parent'}, {fork: {sessionID: 'old'}},
    {time: {created: Date.now(), archived: Date.now()}}, {location: {directory: 'Z:/elsewhere'}},
  ]) {
    const h = await harness({session});
    try { await h.create(); assert.equal(h.store.has('sessions/s1'), false); }
    finally { await h.ctl.dispose(); }
  }
});

test('native title candidate is pending until host write is observed', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  await h.create();
  h.sessions.get('s1').model = {providerID: 'test', id: 'selected', variant: 'high'};
  const event = {sessionID: 's1', model: {providerID: 'test', id: 'auxiliary-title'}, messages: []};
  await h.ctl.titleHook(event);
  assert.equal(event.result, '[登录接口](修复)刷新失败');
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('sessions/s1').initialNamed, false);
  h.sessions.get('s1').title = event.result;
  await h.emit('session.renamed', {title: event.result});
  assert.equal(h.store.get('sessions/s1').initialNamed, true);
  assert.equal(h.store.get('sessions/s1').pending, null);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].model, h.sessions.get('s1').model);
});

test('direct idle naming confirms its write and repeated events do not regenerate', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  await h.create();
  await h.ctl.evaluate('s1');
  await h.ctl.machine('s1').chain;
  assert.equal(h.writes.length, 1);
  assert.equal(h.store.get('sessions/s1').mode, 'auto');
  await h.emit('session.renamed', {title: h.sessions.get('s1').title});
  await h.ctl.evaluate('s1');
  assert.equal(h.calls.length, 1);
});

test('manual title change including punctuation locks the session', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  await h.create(); await h.ctl.evaluate('s1');
  h.sessions.get('s1').title = '登录接口 | 修复刷新失败';
  await h.emit('session.renamed', {title: h.sessions.get('s1').title});
  assert.equal(h.store.get('sessions/s1').mode, 'locked');
  await assert.rejects(h.ctl.command('refresh', 's1'), /锁定/);
  await h.ctl.command('unlock', 's1');
  assert.equal(h.store.get('sessions/s1').mode, 'auto');
  assert.equal(h.store.get('sessions/s1').baselineTitle, '登录接口 | 修复刷新失败');
  assert.equal(h.calls.length, 1);
});

test('explicit lock persists across plugin instances and blocks refresh', async () => {
  const h = await harness();
  await h.create(); await h.ctl.command('lock', 's1'); await h.ctl.dispose();
  const h2 = await harness({store: h.store});
  try {
    assert.equal((await h2.ctl.status('s1')).mode, 'locked');
    await assert.rejects(h2.ctl.command('refresh', 's1'), /锁定/);
    assert.equal(h2.calls.length, 0);
  } finally { await h2.ctl.dispose(); }
});

test('lock cancels an in-flight generation even if the provider ignores abort', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  await h.create();
  let resolve; let started;
  const ready = new Promise(r => {started = r;});
  h.setGeneration(() => { started(); return new Promise(r => {resolve = r;}); });
  const work = h.ctl.evaluate('s1'); await ready;
  await h.ctl.command('lock', 's1');
  resolve({text: answer()}); await work;
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('sessions/s1').mode, 'locked');
});

test('new input cancels the old result without serializing behind model work', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  let resolve; let started; const ready = new Promise(r => {started = r;});
  h.setGeneration(() => { started(); return new Promise(r => {resolve = r;}); });
  const work = h.ctl.evaluate('s1'); await ready;
  h.contexts.get('s1').push(user('u2', '更正，只设计登录方案'));
  await h.emit('session.inbox.enqueued');
  resolve({text: answer()}); await work;
  assert.equal(h.writes.length, 0);
});

test('silent new input is detected by the final message fingerprint', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => { h.contexts.get('s1').push(user('u2', '更正需求')); return {text: answer()}; });
  await h.ctl.evaluate('s1');
  assert.equal(h.writes.length, 0);
});

test('silent external title change is protected by final read', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => { h.sessions.get('s1').title = '用户已命名'; return {text: answer()}; });
  await h.ctl.evaluate('s1');
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('sessions/s1').mode, 'locked');
});

test('debounce merges idle bursts and does not delay the main conversation', async t => {
  const h = await harness({options: {debounceMs: 35}}); t.after(() => h.ctl.dispose()); await h.create();
  await h.emit('session.idle'); await delay(20); await h.emit('session.idle');
  await delay(20); assert.equal(h.calls.length, 0);
  await delay(35); await h.ctl.machine('s1').flight;
  assert.equal(h.calls.length, 1);
});

test('new input during debounce cancels the pending evaluation', async t => {
  const h = await harness({options: {debounceMs: 30}}); t.after(() => h.ctl.dispose()); await h.create();
  await h.emit('session.idle'); await h.emit('session.inbox.enqueued'); await delay(45);
  assert.equal(h.calls.length, 0);
});

test('cooldown schedules one deferred evaluation without requiring another event', async t => {
  const h = await harness({options: {cooldownMs: 90}}); t.after(() => h.ctl.dispose()); await h.create();
  h.contexts.get('s1').push(assistant()); await h.ctl.evaluate('s1');
  h.contexts.get('s1').push(user('u2', '换个话题，排查 Redis 连接失败'));
  h.setGeneration(async () => ({text: JSON.stringify({action: 'keep', reasonCode: 'no_change'})}));
  await h.ctl.evaluate('s1'); assert.equal(h.calls.length, 1);
  await delay(110); await h.ctl.machine('s1').flight;
  assert.equal(h.calls.length, 2);
});

test('ordinary follow-up below four new meaningful turns does not evaluate', async t => {
  const h = await harness({options: {cooldownMs: 0}}); t.after(() => h.ctl.dispose()); await h.create();
  h.contexts.get('s1').push(assistant()); await h.ctl.evaluate('s1');
  h.contexts.get('s1').push(user('u2', '登录接口刷新失败的日志再看看'));
  await h.ctl.evaluate('s1'); assert.equal(h.calls.length, 1);
});

test('first assistant reply permits one calibration after the native title', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  const event = {sessionID: 's1'}; await h.ctl.titleHook(event);
  h.sessions.get('s1').title = event.result; await h.emit('session.renamed', {title: event.result});
  h.contexts.get('s1').push(assistant());
  h.setGeneration(async () => ({text: JSON.stringify({action: 'keep', reasonCode: 'no_change'})}));
  await h.ctl.evaluate('s1'); await h.ctl.evaluate('s1');
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.get('sessions/s1').calibrated, true);
});

test('failed generation retries the same snapshot up to three times, then stops', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => {throw new Error('provider failure');});
  const result = await h.ctl.evaluate('s1');
  assert.equal(result.outcome, 'model_failed');
  assert.equal(h.calls.length, 3);
  assert.equal(h.writes.length, 0);
  const state = h.store.get('sessions/s1');
  assert.equal(state.generationAttempts, 3);
  assert.equal(state.generationMaxAttempts, 3);
  assert.equal(state.lastGenerationFailure, 'model_failed');
  assert.equal(state.lastOutcome, 'model_failed');
  // The same snapshot is exhausted: another idle evaluation must not re-request.
  await h.ctl.evaluate('s1');
  assert.equal(h.calls.length, 3);
  h.setGeneration(async () => ({text: 'not JSON'}));
  await assert.rejects(h.ctl.command('refresh', 's1'), /invalid_invalid_json/);
  assert.equal(h.calls.length, 4, 'invalid output is not retried');
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('sessions/s1').lastOutcome, 'invalid_invalid_json');
});

test('timeout retries each attempt with a fresh signal and ignores late results', async t => {
  const h = await harness({options: {timeoutMs: 250}}); t.after(() => h.ctl.dispose()); await h.create();
  const resolvers = [];
  const signals = [];
  h.setGeneration((_input, opts) => {
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(opts.signal.aborted, false, 'a new attempt starts unaborted');
    signals.push(opts.signal);
    return new Promise(resolve => { resolvers.push(resolve); });
  });
  const result = await awaitHostWork(h.ctl.evaluate('s1'));
  assert.equal(result.outcome, 'generation_timeout');
  assert.equal(h.calls.length, 3);
  assert.equal(new Set(signals).size, 3, 'each attempt gets its own signal');
  assert.equal(new Set(resolvers).size, 3, 'each attempt gets its own request');
  for (const signal of signals) assert.equal(signal.aborted, true, 'each deadline aborts its attempt');
  const state = h.store.get('sessions/s1');
  assert.equal(state.generationAttempts, 3);
  assert.equal(state.lastGenerationFailure, 'generation_timeout');
  assert.equal(state.lastOutcome, 'generation_timeout');
  for (const resolve of resolvers) resolve({text: answer()});
  await delay(10);
  assert.equal(h.writes.length, 0);
});

test('a timed-out attempt followed by a successful retry writes once', async t => {
  const h = await harness({options: {timeoutMs: 60, maxGenerationRetries: 1}});
  t.after(() => h.ctl.dispose()); await h.create();
  let calls = 0;
  const signals = [];
  h.setGeneration((_input, opts) => {
    calls += 1;
    signals.push(opts.signal);
    if (calls === 1) return new Promise(() => {}); // provider ignores abort
    return Promise.resolve({text: answer()});
  });
  const result = await awaitHostWork(h.ctl.evaluate('s1'));
  assert.equal(result.outcome, 'renamed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(h.store.get('sessions/s1').generationAttempts, 2);
  assert.equal(h.store.get('sessions/s1').lastGenerationFailure, null);
});

test('dispose prevents old model results from writing after reload', async () => {
  const h = await harness(); await h.create();
  let resolve; let started; const ready = new Promise(r => {started = r;});
  h.setGeneration(() => { started(); return new Promise(r => {resolve = r;}); });
  const work = h.ctl.evaluate('s1'); await ready; await h.ctl.dispose();
  resolve({text: answer()}); await work; assert.equal(h.writes.length, 0);
});

test('an uncommitted native pending candidate is recovered rather than blocking forever', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  await h.ctl.titleHook({sessionID: 's1'});
  assert.ok(h.store.get('sessions/s1').pending);
  h.contexts.get('s1').push(assistant());
  await h.ctl.evaluate('s1');
  await delay(80); await h.ctl.machine('s1').flight;
  assert.equal(h.writes.length, 1);
  assert.equal(h.store.get('sessions/s1').pending, null);
});

test('archive and move during generation prevent writes; delete cleans state', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => { h.sessions.get('s1').time.archived = Date.now(); return {text: answer()}; });
  await h.ctl.evaluate('s1'); assert.equal(h.writes.length, 0);
  await h.emit('session.deleted'); assert.equal(h.store.has('sessions/s1'), false);
});

test('commands register without any prompt or synthetic-message call', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose());
  assert.deepEqual([...h.commands.keys()], ['autotitle-lock', 'autotitle-unlock', 'autotitle-refresh']);
  await h.commands.get('autotitle-lock').execute({sessionID: 's1'});
  assert.equal(h.store.get('sessions/s1').mode, 'locked');
});

test('plugin model override wins over the current session and agent', async () => {
  const override = {providerID: 'configured', id: 'title', variant: 'low'};
  const selected = await selectNamingModel({}, {model: {providerID: 'session', id: 'main'}}, override);
  assert.deepEqual(selected, override);
});

test('effective model follows selected session, then agent, then current host default', async () => {
  const agentModel = {providerID: 'agent', id: 'main', variant: 'high'};
  const ctx = {agent: {get: async () => ({data: {model: agentModel}})}, model: {default: async () => ({data: {providerID: 'host', id: 'default'}})}};
  const selected = {providerID: 'session', id: 'current', variant: 'low'};
  assert.deepEqual(await selectNamingModel(ctx, {agent: 'build', model: selected}), selected);
  assert.deepEqual(await selectNamingModel(ctx, {agent: 'build'}), agentModel);
  assert.deepEqual(await selectNamingModel(ctx, {}), {providerID: 'host', id: 'default'});
});

test('changing session model affects the next request, not a cached title model', async t => {
  const h = await harness({session: {model: {providerID: 'test', id: 'first', variant: 'high'}}});
  t.after(() => h.ctl.dispose()); await h.create(); await h.ctl.evaluate('s1');
  h.sessions.get('s1').model = {providerID: 'test', id: 'second', variant: 'low'};
  h.setGeneration(async () => ({text: JSON.stringify({action: 'keep', reasonCode: 'no_change'})}));
  await h.ctl.command('refresh', 's1');
  assert.deepEqual(h.calls[1].model, h.sessions.get('s1').model);
});

test('free-model session transport retains controller retries, model selection, and single title commit', async t => {
  const model = {providerID: 'opencode', id: 'catalog-free', variant: 'default'};
  const h = await harness({session: {model}});t.after(() => h.ctl.dispose());
  h.ctx.model = {list: async () => ({data: [{...model, cost: [{input: 0, output: 0}]}]})};
  let attempts = 0;
  h.setGeneration(async () => {if (++attempts === 1) throw new Error('temporary failure');return {text: answer()};});
  await h.ctl.command('refresh', 's1');
  assert.equal(h.calls.length, 2);assert.deepEqual(h.calls[0], h.calls[1]);
  assert.deepEqual(h.calls[1].model, model);assert.equal(h.writes.length, 1);
  assert.equal((await h.ctl.status('s1')).lastGenerationRoute, 'session');
});

test('transient naming helpers are excluded even when managing ordinary child sessions', async t => {
  const h = await harness({options: {manageSubsessions: true}, session: {
    parentID: 'parent', metadata: {'session-autotitle.transient': true},
  }});t.after(() => h.ctl.dispose());
  await h.create();assert.equal(h.store.has('sessions/s1'), false);
  assert.equal((await h.ctl.status('s1')).managed, false);
});

test('a model switch during generation discards the old-model result', async t => {
  const h = await harness({session: {model: {providerID: 'test', id: 'first'}}});
  t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => {h.sessions.get('s1').model = {providerID: 'test', id: 'second'}; return {text: answer()};});
  const result = await h.ctl.evaluate('s1');
  assert.equal(result.outcome, 'model_changed'); assert.equal(h.writes.length, 0);
});

test('idle arriving during native generation is not lost and calibrates after commit', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  let resolve; let started; const ready = new Promise(r => {started = r;});
  h.setGeneration(() => {started(); return new Promise(r => {resolve = r;});});
  const event = {sessionID: 's1'};
  const work = h.ctl.titleHook(event); await ready;
  h.contexts.get('s1').push(assistant());
  assert.equal((await h.ctl.evaluate('s1', {source: 'idle'})).outcome, 'inflight');
  resolve({text: answer()}); await work;
  h.sessions.get('s1').title = event.result; await h.emit('session.renamed', {title: event.result});
  h.setGeneration(async () => ({text: JSON.stringify({action: 'keep', reasonCode: 'no_change'})}));
  await delay(35); await h.ctl.machine('s1').flight;
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.get('sessions/s1').calibrated, true);
});

test('one failure then success writes exactly one title', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  let calls = 0;
  h.setGeneration(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return {text: answer()};
  });
  const result = await h.ctl.evaluate('s1');
  assert.equal(result.outcome, 'renamed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 1);
  const state = h.store.get('sessions/s1');
  assert.equal(state.generationAttempts, 2);
  assert.equal(state.generationMaxAttempts, 3);
  assert.equal(state.lastGenerationFailure, null);
  assert.equal(state.lastOutcome, 'renamed');
});

test('two failures then success issues three calls and one write', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  let calls = 0;
  h.setGeneration(async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return {text: answer()};
  });
  const result = await h.ctl.evaluate('s1');
  assert.equal(result.outcome, 'renamed');
  assert.equal(h.calls.length, 3);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.calls[1], h.calls[0], 'retry reuses the prepared prompt and model');
  assert.deepEqual(h.calls[2], h.calls[0]);
  assert.equal(h.store.get('sessions/s1').generationAttempts, 3);
});

test('maxGenerationRetries 0/1/2 bounds the total attempts at three', async () => {
  for (const retries of [0, 1, 2]) {
    const h = await harness({options: {maxGenerationRetries: retries}});
    try {
      await h.create();
      h.setGeneration(async () => {throw new Error('provider failure');});
      const result = await h.ctl.evaluate('s1');
      assert.equal(result.outcome, 'model_failed', `retries=${retries}`);
      assert.equal(h.calls.length, retries + 1, `retries=${retries}`);
      const state = h.store.get('sessions/s1');
      assert.equal(state.generationMaxAttempts, retries + 1);
      assert.equal(state.generationAttempts, retries + 1);
    } finally { await h.ctl.dispose(); }
  }
});

test('retry-wait status exposes attempts, max and a safe failure code', async t => {
  const seen = [];
  let h;
  h = await harness({sleep: async () => { seen.push(await h.ctl.status('s1')); }});
  t.after(() => h.ctl.dispose()); await h.create();
  let calls = 0;
  h.setGeneration(async () => {
    calls += 1;
    if (calls === 1) throw new Error('private provider message');
    return {text: answer()};
  });
  await h.ctl.evaluate('s1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].lastOutcome, 'retry_wait');
  assert.equal(seen[0].generationAttempts, 1);
  assert.equal(seen[0].generationMaxAttempts, 3);
  assert.equal(seen[0].lastGenerationFailure, 'model_failed');
  assert.equal(JSON.stringify(seen[0]).includes('private provider message'), false);
  const final = await h.ctl.status('s1');
  assert.equal(final.generationAttempts, 2);
  assert.equal(final.lastGenerationFailure, null);
});

test('injected backoff uses 1s then 2s and cancellation clears a real wait quickly', async () => {
  const delays = [];
  const h = await harness({sleep: async (ms) => { delays.push(ms); }});
  try {
    await h.create();
    let calls = 0;
    h.setGeneration(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return {text: answer()};
    });
    const result = await h.ctl.evaluate('s1');
    assert.equal(result.outcome, 'renamed');
    assert.deepEqual(delays, [1000, 2000]);
  } finally { await h.ctl.dispose(); }
});

test('production backoff waits one second before retrying and cancels promptly', async () => {
  // Retry succeeds after the real 1s backoff.
  const h = await harness({sleep: null}); // exercise the production sleep
  try {
    await h.create();
    let calls = 0;
    h.setGeneration(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return {text: answer()};
    });
    const started = Date.now();
    const result = await awaitHostWork(h.ctl.evaluate('s1'));
    assert.equal(result.outcome, 'renamed');
    assert.equal(h.calls.length, 2);
    assert.ok(Date.now() - started >= 950, 'first retry waits about 1s');
  } finally { await h.ctl.dispose(); }

  // Cancelling during the real 1s wait returns immediately and never retries.
  const c = await harness({sleep: null});
  try {
    await c.create();
    c.setGeneration(async () => { throw new Error('provider failure'); });
    const work = c.ctl.evaluate('s1');
    for (let i = 0; i < 100 && (await c.ctl.status('s1')).lastOutcome !== 'retry_wait'; i += 1) await delay(10);
    assert.equal((await c.ctl.status('s1')).lastOutcome, 'retry_wait');
    const cancelledAt = Date.now();
    await c.emit('session.inbox.enqueued');
    const result = await work;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(c.calls.length, 1);
    assert.ok(Date.now() - cancelledAt < 500, 'backoff wake-up is prompt');
    assert.equal((await c.ctl.status('s1')).lastOutcome, 'cancelled');
  } finally { await c.ctl.dispose(); }
});

test('lock, new input or unload during the retry backoff stops the chain', async () => {
  for (const action of ['lock', 'input', 'dispose']) {
    let sleeping;
    const entered = new Promise(resolve => { sleeping = resolve; });
    const h = await harness({sleep: (_ms, signal) => new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, {once: true});
      sleeping();
    })});
    await h.create();
    h.setGeneration(async () => { throw new Error('provider failure'); });
    const work = h.ctl.evaluate('s1');
    await entered;
    if (action === 'lock') await h.ctl.command('lock', 's1');
    else if (action === 'input') await h.emit('session.inbox.enqueued');
    else await h.ctl.dispose();
    const result = await work;
    assert.equal(result.outcome, 'cancelled', action);
    assert.equal(h.calls.length, 1, action);
    assert.equal(h.writes.length, 0, action);
    if (action === 'lock') {
      assert.equal(h.store.get('sessions/s1').mode, 'locked');
      assert.equal(h.store.get('sessions/s1').lastOutcome, 'locked');
    } else if (action === 'input') {
      assert.equal(h.store.get('sessions/s1').lastOutcome, 'cancelled');
    }
    if (action !== 'dispose') await h.ctl.dispose();
  }
});

test('event-less title, model, context or archive changes block a retry', async () => {
  for (const change of ['title', 'model', 'context', 'archived']) {
    let sleeps = 0;
    const h = await harness({sleep: async () => { sleeps += 1; }});
    try {
      await h.create();
      h.setGeneration(async () => {
        if (change === 'title') h.sessions.get('s1').title = '用户已命名';
        if (change === 'model') h.sessions.get('s1').model = {providerID: 'test', id: 'second'};
        if (change === 'context') h.contexts.get('s1').push(user('u2', '完全改做另一个任务'));
        if (change === 'archived') h.sessions.get('s1').time.archived = Date.now();
        throw new Error('provider failure');
      });
      const expected = {title: 'external_rename', model: 'model_changed', context: 'stale', archived: 'ineligible'}[change];
      const result = await h.ctl.evaluate('s1');
      assert.equal(result.outcome, expected, change);
      assert.equal(h.calls.length, 1, change);
      assert.equal(h.writes.length, 0, change);
      assert.equal(sleeps, 0, `${change}: no backoff is entered`);
      assert.equal((await h.ctl.status('s1')).lastOutcome, expected, `${change}: no fake retry_wait`);
    } finally { await h.ctl.dispose(); }
  }
});

test('cancelling while a retry check is reading the session stops before backoff', async t => {
  let sleeps = 0;
  const h = await harness({sleep: async () => { sleeps += 1; }});
  t.after(() => h.ctl.dispose()); await h.create();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.setGeneration(async () => {
    h.ctx.session.get = async () => { await gate; return copy(h.sessions.get('s1')); };
    throw new Error('provider failure');
  });
  const work = h.ctl.evaluate('s1');
  await delay(20); // retryAllowed is now awaiting session.get
  h.ctl.cancel(h.ctl.machine('s1'));
  release();
  const result = await work;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(h.calls.length, 1);
  assert.equal(sleeps, 0, 'a cancelled retry never enters backoff');
  assert.equal((await h.ctl.status('s1')).lastOutcome, 'cancelled');
});

test('invalid JSON and title write errors are never retried', async t => {
  const invalid = await harness(); t.after(() => invalid.ctl.dispose());
  await invalid.create();
  invalid.setGeneration(async () => ({text: 'not JSON'}));
  const result = await invalid.ctl.evaluate('s1');
  assert.equal(result.outcome, 'invalid_invalid_json');
  assert.equal(invalid.calls.length, 1);

  const failing = await harness(); t.after(() => failing.ctl.dispose());
  await failing.create();
  failing.ctx.session.update = async () => { throw new Error('write failed'); };
  const write = await failing.ctl.evaluate('s1');
  assert.equal(write.outcome, 'write_uncertain');
  assert.equal(failing.calls.length, 1);
  assert.equal(failing.store.get('sessions/s1').lastOutcome, 'write_uncertain');
});

test('fulfilled requests with missing, empty or non-string output never retry', async () => {
  for (const response of [{}, undefined, null, {text: undefined}, {text: null}, {text: ''}, {text: 0}, {text: {}}]) {
    const h = await harness();
    try {
      await h.create();
      h.setGeneration(async () => response);
      const result = await h.ctl.evaluate('s1');
      assert.equal(result.outcome, 'invalid_invalid_json');
      assert.equal(h.calls.length, 1, 'a fulfilled request must leave the retry loop');
      assert.equal(h.writes.length, 0);
      assert.equal((await h.ctl.status('s1')).generationAttempts, 1);
    } finally { await h.ctl.dispose(); }
  }
});

test('invalid output after a request failure stops at the successful second request', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => {
    if (h.calls.length === 1) throw new Error('transient');
    return {};
  });
  const result = await h.ctl.evaluate('s1');
  assert.equal(result.outcome, 'invalid_invalid_json');
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 0);
});

test('cancellation during final failure persistence wins without overwriting later commands', async () => {
  for (const retries of [0, 2]) for (const action of ['input', 'lock', 'unlock']) {
    const h = await harness({options: {maxGenerationRetries: retries}});
    let release;
    try {
      await h.create();
      const gate = new Promise(resolve => { release = resolve; });
      let entered;
      const saving = new Promise(resolve => { entered = resolve; });
      const set = h.ctx.storage.set;
      let held = false;
      h.ctx.storage.set = async (key, value) => {
        await set(key, value);
        if (!held && value.lastOutcome === 'model_failed') {
          held = true; entered(); await gate;
        }
      };
      h.setGeneration(async () => { throw new Error('provider failure'); });
      const work = h.ctl.evaluate('s1');
      await saving;
      const newer = action === 'input' ? h.emit('session.inbox.enqueued') : h.ctl.command(action, 's1');
      release(); await newer;
      assert.equal((await work).outcome, 'cancelled', `${action}, retries=${retries}`);
      assert.equal(h.calls.length, retries + 1);
      assert.equal(h.writes.length, 0);
      assert.equal((await h.ctl.status('s1')).lastOutcome,
        {input: 'cancelled', lock: 'locked', unlock: 'unlocked'}[action]);
    } finally { release?.(); await h.ctl.dispose(); }
  }
});

test('model selection event during backoff clears running status even after fingerprint reset', async () => {
  let h;
  h = await harness({sleep: async () => {
    h.sessions.get('s1').model = {providerID: 'test', id: 'changed'};
    await h.emit('session.model.selected');
  }});
  try {
    await h.create();
    h.setGeneration(async () => { throw new Error('provider failure'); });
    assert.equal((await h.ctl.evaluate('s1')).outcome, 'cancelled');
    assert.equal(h.calls.length, 1);
    const state = h.store.get('sessions/s1');
    assert.equal(state.attemptFingerprint, '', 'next activity may use the new model');
    assert.equal(state.lastOutcome, 'cancelled');
  } finally { await h.ctl.dispose(); }
});

test('each failed request releases its signal before backoff and late rejections are handled', async t => {
  const signals = [];
  const h = await harness({options: {timeoutMs: 250}, sleep: async () => {
    assert.equal(signals.at(-1).aborted, true, 'failed attempt cleaned up before waiting');
  }});
  t.after(() => h.ctl.dispose()); await h.create();
  let rejectLate;
  h.setGeneration((_input, {signal}) => {
    signals.push(signal);
    assert.equal(signal.aborted, false);
    if (h.calls.length === 1) throw new Error('transient');
    if (h.calls.length === 2) return new Promise((_, reject) => { rejectLate = reject; });
    return {text: answer()};
  });
  const work = h.ctl.evaluate('s1');
  // Keep the test process alive while exercising an unref'ed deadline.
  await delay(300);
  assert.equal((await work).outcome, 'renamed');
  rejectLate(new Error('late private provider failure'));
  await delay(10);
  assert.equal(h.calls.length, 3);
  assert.equal(h.writes.length, 1);
  assert.ok(signals.every(signal => signal.aborted));
});

test('cancellation during pre-request save records no phantom generation attempt', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  const set = h.ctx.storage.set;
  let preparing = 0;
  h.ctx.storage.set = async (key, value) => {
    await set(key, value);
    if (value.lastOutcome === 'generating' && ++preparing === 2) h.ctl.cancel(h.ctl.machine('s1'));
  };
  assert.equal((await h.ctl.evaluate('s1')).outcome, 'cancelled');
  assert.equal(h.calls.length, 0);
  const status = await h.ctl.status('s1');
  assert.equal(status.generationAttempts, 0);
  assert.equal(status.lastOutcome, 'cancelled');
});

test('keep and defer are successful requests, not retryable failures', async () => {
  for (const action of ['keep', 'defer']) {
    const h = await harness({session: {title: '已有标题'}});
    try {
      await h.create();
      h.setGeneration(async () => ({text: JSON.stringify({action, reasonCode: 'no_change'})}));
      assert.equal((await h.ctl.evaluate('s1')).outcome, action);
      assert.equal(h.calls.length, 1);
      assert.equal(h.writes.length, 0);
    } finally { await h.ctl.dispose(); }
  }
});

test('retry exhaustion preserves the existing title and task ledger', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  await h.ctl.command('refresh', 's1');
  const before = copy(h.store.get('sessions/s1'));
  h.setGeneration(async () => { throw new Error('private provider failure'); });
  await assert.rejects(h.ctl.command('refresh', 's1'), /model_failed/);
  const after = h.store.get('sessions/s1');
  assert.equal(h.calls.length, 4);
  assert.equal(h.writes.length, 1, 'only the initial successful title was written');
  assert.equal(h.sessions.get('s1').title, before.baselineTitle);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.evaluatedUserIDs, before.evaluatedUserIDs);
  assert.equal(after.lastOutcome, 'model_failed');
  assert.equal(JSON.stringify(after).includes('private provider failure'), false);
});

test('native title retry reuses the single request path and never falls back to a second model', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  let calls = 0;
  h.setGeneration(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return {text: answer()};
  });
  const event = {sessionID: 's1'};
  await h.ctl.titleHook(event);
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 0);
  assert.equal(event.result, '[登录接口](修复)刷新失败');
  assert.equal(h.store.get('sessions/s1').generationAttempts, 2);
});

test('manual refresh retries a request failure and reports the final reason', async t => {
  const h = await harness(); t.after(() => h.ctl.dispose()); await h.create();
  h.setGeneration(async () => {throw new Error('provider failure');});
  await assert.rejects(h.ctl.command('refresh', 's1'), /本次生成尝试已耗尽/);
  assert.equal(h.calls.length, 3);
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('sessions/s1').lastOutcome, 'model_failed');
});
