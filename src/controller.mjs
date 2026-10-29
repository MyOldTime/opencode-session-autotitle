import path from 'node:path';
import {
  normalizeOptions, buildNamingPrompt, parseNamingResult, meaningfulUserText,
  isExplicitTopicChange, titleFingerprint, redactSensitive, truncateGraphemes,
} from './naming.mjs';

export const PLUGIN_ID = 'local.session-autotitle';
export const EVENT_TYPES = [
  'session.created', 'session.renamed', 'session.moved', 'session.deleted',
  'session.archived', 'session.unarchived', 'session.forked',
  'session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled',
  'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted', 'session.idle',
  'session.revert.committed',
  'session.model.selected', 'session.agent.selected',
  'session.compaction.ended',
];

const titleOf = (info) => info.title ?? '';
const keyOf = (id) => `sessions/${id}`;
/** Backoff before retry N (index 0 = second attempt). Not configurable. */
const RETRY_DELAYS_MS = Object.freeze([1000, 2000]);

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

/** Abort-aware production backoff; tests inject a deterministic replacement. */
function defaultSleep(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return '';
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** V2 messages: only durable user text and visible assistant text are inputs. */
export function normalizeMessages(messages = []) {
  return messages.flatMap((message) => {
    if (message.type === 'user') return [{ id: message.id, role: 'user', text: message.text ?? '' }];
    if (message.type === 'assistant') {
      const text = (message.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      return text ? [{ id: message.id, role: 'assistant', text }] : [];
    }
    return [];
  });
}

/** Compaction is historical context, never a fabricated new user turn. */
export function latestCompaction(messages = []) {
  const message = [...messages].reverse().find((m) => m.type === 'compaction'
    && m.status === 'completed' && typeof m.summary === 'string' && m.summary.trim());
  return message ? { id: message.id, text: message.summary } : null;
}

function readContext(messages) {
  const visible = normalizeMessages(messages);
  const summary = latestCompaction(messages);
  const sig = signatures(visible);
  const basis = titleFingerprint(JSON.stringify([sig.user, summary?.id, summary?.text]));
  return { messages: visible, summary, sig, basis,
    fingerprint: titleFingerprint(JSON.stringify([sig.full, summary?.id, summary?.text])) };
}

function normalizeHookMessages(messages = []) {
  return messages.flatMap((message, index) => {
    if (!['user', 'assistant'].includes(message.role)) return [];
    const content = message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
    return text ? [{ id: `hook-${index}`, role: message.role, text }] : [];
  });
}

function signatures(messages) {
  const users = messages.filter((m) => m.role === 'user');
  return {
    user: titleFingerprint(JSON.stringify(users.map((m) => [m.id, m.text]))),
    full: titleFingerprint(JSON.stringify(messages.map((m) => [m.id, m.role, m.text]))),
    meaningful: users.filter((m) => meaningfulUserText(m.text)),
  };
}

function initialState(info, reason) {
  return {
    schema: 1, mode: 'auto', reason, baselineTitle: titleOf(info), tasks: [], anchor: null,
    initialNamed: false, calibrated: false, evaluatedUserIDs: [], lastAttemptAt: 0,
    attemptFingerprint: '', lastOutcome: 'not_evaluated', pending: null, model: null,
    generationAttempts: 0, generationMaxAttempts: 0, lastGenerationFailure: null,
  };
}

/** Resolve afresh for every request; an old title-model cache never wins. */
export async function selectNamingModel(ctx, info, override) {
  if (override) return override;
  if (info.model) return info.model;
  // With no explicit session selection, the active agent is part of OpenCode's
  // effective model selection. Preserve its variant as well as its model ID.
  if (info.agent && ctx.agent?.get) {
    const agent = await ctx.agent.get({ agentID: info.agent });
    if (agent.data?.model) return agent.data.model;
  }
  if (ctx.model?.default) {
    const selected = await ctx.model.default();
    if (selected.data) return { providerID: selected.data.providerID, id: selected.data.id };
  }
  // Omitting model delegates to the host's current default, not a cached ref.
  return undefined;
}

/** Short state transitions are serialized; model calls never occupy this queue. */
export class AutoTitleController {
  constructor(ctx, { now = Date.now, log = (code, id) => console.warn(`[autotitle] ${code} ${id ?? ''}`), sleep = defaultSleep } = {}) {
    this.ctx = ctx;
    this.options = normalizeOptions(ctx.options ?? {});
    this.now = now;
    this.log = log;
    this.sleep = sleep;
    this.life = new AbortController();
    this.machines = new Map();
    this.registrations = [];
    this.closed = false;
    this.startedAt = now();
    this.streamTask = null;
  }

  machine(id) {
    let m = this.machines.get(id);
    if (!m) {
      m = { id, epoch: 0, chain: Promise.resolve(), state: undefined, loaded: false,
        timer: null, busy: false, flight: null, generation: null, removed: false, idleAfterFlight: false };
      this.machines.set(id, m);
    }
    return m;
  }

  serial(m, fn) {
    const result = m.chain.catch(() => {}).then(fn);
    m.chain = result.catch(() => {});
    return result;
  }

  async state(m) {
    if (!m.loaded) {
      const value = await this.ctx.storage.get(keyOf(m.id));
      m.state = value?.schema === 1 ? value : null;
      // Earlier versions represented fork exclusion as a lock. Scope is not a
      // lock; preserve actual explicit_lock/external_rename records as-is.
      if (m.state?.mode === 'locked' && m.state.reason === 'fork_not_adopted') {
        m.state.mode = 'auto';
        m.state.reason = 'default_unlocked';
        m.state.pending = null;
        m.state.lastOutcome = 'not_evaluated';
      }
      m.loaded = true;
    }
    return m.state;
  }

  async save(m) {
    if (!this.closed && !m.removed && m.state) await this.ctx.storage.set(keyOf(m.id), clone(m.state));
  }

  owns(info) {
    return normalizeDirectory(info?.location?.directory) === normalizeDirectory(this.ctx.location.directory);
  }

  eligible(info) {
    return this.owns(info) && !info.time?.archived && (this.options.manageSubsessions || !info.parentID);
  }

  automaticScope(info, state) {
    return this.eligible(info) && (!info.fork || state?.forkAdopted === true);
  }

  async ensureState(m, info, { explicit = false, reason = 'default_unlocked' } = {}) {
    let state = await this.state(m);
    if (!state && this.eligible(info) && (!info.fork || explicit)) {
      m.state = state = initialState(info, reason);
      if (explicit && info.fork) state.forkAdopted = true;
      await this.save(m);
    }
    return state;
  }

  async outcome(m, outcome) {
    if (!this.closed && !m.removed && m.state) {
      m.state.lastOutcome = outcome;
      await this.save(m);
    }
    return { outcome };
  }

  cancel(m) {
    m.epoch++;
    m.idleAfterFlight = false;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    m.generation?.abort();
  }

  async lockState(m, currentTitle, reason) {
    this.cancel(m);
    m.state.mode = 'locked';
    m.state.reason = reason;
    m.state.baselineTitle = currentTitle;
    m.state.pending = null;
    m.state.lastOutcome = 'locked';
    await this.save(m);
  }

  /** Confirm a native/explicit write, or conservatively yield to an external title. */
  async reconcile(m, info, { recovering = false } = {}) {
    const state = await this.state(m);
    if (!state) return null;
    const title = titleOf(info);
    if (state.pending && title === state.pending.title) {
      const p = state.pending;
      state.baselineTitle = title;
      state.tasks = p.tasks;
      state.initialNamed = true;
      state.pending = null;
      state.lastOutcome = 'renamed';
      await this.save(m);
    } else if (title !== state.baselineTitle) {
      await this.lockState(m, title, 'external_rename');
    } else if (state.pending && recovering) {
      state.pending = null;
      await this.save(m);
    }
    return state;
  }

  schedule(m, delay = this.options.debounceMs) {
    if (this.closed || m.removed || m.busy) return;
    if (m.timer) clearTimeout(m.timer);
    m.timer = setTimeout(() => {
      m.timer = null;
      void this.evaluate(m.id, { source: 'idle' }).catch(() => this.log('evaluation_failed', m.id));
    }, delay);
    m.timer.unref?.();
  }

  async start({ subscribe = true } = {}) {
    const saved = await this.ctx.storage.get('meta/installed-at');
    if (typeof saved === 'number') this.startedAt = saved;
    else await this.ctx.storage.set('meta/installed-at', this.startedAt);
    this.registrations.push(await this.ctx.session.hook('title', (event) => this.titleHook(event)));
    this.registrations.push(await this.ctx.command.transform((editor) => {
      for (const [name, description, operation] of [
        ['autotitle-lock', '锁定当前会话名称，停止自动命名', 'lock'],
        ['autotitle-unlock', '允许自动管理当前会话名称，不立即改名', 'unlock'],
        ['autotitle-refresh', '立即评估会话名称（遵守锁定状态）', 'refresh'],
      ]) editor.add({ name, description, execute: async ({ sessionID }) => { await this.command(operation, sessionID); } });
    }));
    if (this.ctx.tool?.transform) this.registrations.push(await this.ctx.tool.transform((editor) => {
      editor.add({
        name: 'autotitle_status', description: 'Read the current session automatic-title ownership, lock and last evaluation status. Does not rename or unlock.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ content: JSON.stringify(await this.status(context.sessionID)) }),
      });
    }));
    if (subscribe) this.streamTask = this.consume();
    await this.recover();
    return this;
  }

  async recover() {
    let after;
    // Bounded reconciliation of owned records only; never scan and adopt history.
    for (let page = 0; page < 5 && !this.closed; page++) {
      const result = await this.ctx.storage.scan({ prefix: 'sessions/', limit: 50, ...(after ? { after } : {}) });
      for (const entry of result.entries) {
        if (this.closed) break;
        const id = entry.key.slice('sessions/'.length);
        try {
          const info = await this.ctx.session.get({ sessionID: id });
          if (!this.owns(info)) continue;
          const m = this.machine(id);
          await this.serial(m, async () => {
            await this.reconcile(m, info, { recovering: true });
            // Reload/read/unlock alone must not rename existing conversations.
            // Normal activity or an explicit refresh resumes evaluation.
          });
        } catch { /* deleted or temporarily unavailable: do not adopt or overwrite */ }
      }
      after = result.next;
      if (!after) break;
    }
  }

  async consume() {
    let delay = 1000;
    while (!this.closed) {
      try {
        for await (const event of this.ctx.event.subscribe({ types: EVENT_TYPES, signal: this.life.signal })) {
          if (this.closed) break;
          // Only dispatch: don't hold the server's shared event stream for I/O/LLM.
          void this.handleEvent(event).catch(() => this.log('event_failed', event.data?.sessionID));
          delay = 1000;
        }
      } catch { if (!this.closed) this.log('event_stream_disconnected'); }
      if (this.closed) break;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); this.life.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, delay);
        timer.unref?.();
        this.life.signal.addEventListener('abort', done, { once: true });
      });
      delay = Math.min(delay * 2, 30000);
      if (!this.closed) await this.recover().catch(() => this.log('recovery_failed'));
    }
  }

  handleEvent(event) {
    if (this.closed) return Promise.resolve();
    const data = event.data;
    const id = data?.sessionID;
    if (typeof id !== 'string') return Promise.resolve();
    const known = this.machines.get(id);
    const eventLocation = event.location ?? (event.type === 'session.created' ? data.location : null);
    if (eventLocation && normalizeDirectory(eventLocation.directory) !== normalizeDirectory(this.ctx.location.directory) && !known) return Promise.resolve();
    const m = known ?? this.machine(id);
    const input = event.type === 'session.inbox.enqueued' || event.type === 'session.inbox.delivered';
    const cancelTypes = ['session.execution.started', 'session.archived', 'session.deleted', 'session.moved', 'session.forked', 'session.revert.committed', 'session.model.selected', 'session.agent.selected'];
    if (input || cancelTypes.includes(event.type)) this.cancel(m);
    // Inbox controls and resume:false admissions do not necessarily start a run.
    if (event.type === 'session.execution.started') m.busy = true;
    if (event.type === 'session.renamed' && m.state && data.title !== m.state.baselineTitle && data.title !== m.state.pending?.title) this.cancel(m);
    return this.serial(m, async () => {
      if (this.closed) return;
      if (event.type === 'session.deleted') {
        m.removed = true;
        m.state = null;
        await this.ctx.storage.remove(keyOf(id));
        this.machines.delete(id);
        return;
      }
      if (event.type === 'session.created') {
        const info = await this.ctx.session.get({ sessionID: id });
        await this.ensureState(m, info, { reason: 'new_session' });
        return;
      }
      const info = await this.ctx.session.get({ sessionID: id });
      if (!this.owns(info)) return;
      const previous = await this.state(m);
      const state = await this.ensureState(m, info);
      if (!state) return;
      if (event.type === 'session.renamed') {
        // A rename event is different from merely discovering an old title.
        // Own/native pending writes are reconciled, not locked.
        if (!previous) await this.lockState(m, titleOf(info), 'external_rename');
        else await this.reconcile(m, info);
      } else if (event.type === 'session.model.selected' || event.type === 'session.agent.selected') {
        state.pending = null;
        state.attemptFingerprint = '';
        await this.save(m);
      } else if (event.type === 'session.forked') {
        state.pending = null;
        await this.save(m);
      } else if (event.type === 'session.archived' || event.type === 'session.moved') {
        state.pending = null;
        await this.save(m);
      } else if (event.type === 'session.idle' || event.type.startsWith('session.execution.') && event.type !== 'session.execution.started' || event.type === 'session.unarchived' || event.type === 'session.inbox.cancelled') {
        m.busy = false;
        if (state.mode === 'auto' && this.automaticScope(info, state)) this.schedule(m);
      }
    });
  }

  async titleHook(event) {
    if (this.closed) return;
    const m = this.machine(event.sessionID);
    let managed = false;
    try {
      const info = await this.ctx.session.get({ sessionID: m.id });
      if (!this.eligible(info)) return;
      await this.serial(m, async () => {
        const s = await this.ensureState(m, info, { reason: 'native_title' });
        managed = Boolean(s) && this.automaticScope(info, s);
      });
      if (!managed) return;
      // Always return a result for a managed title hook: avoid a second model
      // request when ours defers or fails. Empty string preserves an empty title.
      event.result = titleOf(info);
      const result = await this.evaluate(m.id, { source: 'native', event });
      const latest = await this.ctx.session.get({ sessionID: m.id });
      event.result = result?.nativeTitle !== undefined && !this.closed && result.epoch === m.epoch
        ? result.nativeTitle : titleOf(latest);
    } catch { if (managed) this.log('native_title_failed', m.id); }
  }

  evaluate(id, request = {}) {
    const m = this.machine(id);
    if (this.closed || m.removed) return Promise.resolve({ outcome: 'closed' });
    if (m.flight) {
      if (request.source === 'idle') m.idleAfterFlight = true;
      return Promise.resolve({ outcome: 'inflight' });
    }
    const flight = this.run(m, request).catch(async (error) => {
      this.log(error?.name === 'AbortError' ? 'cancelled' : 'evaluation_failed', id);
      const outcome = error?.code === 'prompt_budget_exceeded' ? 'prompt_budget_exceeded' : 'evaluation_failed';
      return this.serial(m, () => this.outcome(m, outcome));
    });
    m.flight = flight;
    void flight.finally(() => {
      if (m.flight === flight) m.flight = null;
      if (m.idleAfterFlight) {
        m.idleAfterFlight = false;
        if (m.state?.mode === 'auto') this.schedule(m);
      }
    });
    return flight;
  }

  async run(m, { source = 'idle', event, force = false } = {}) {
    if (source !== 'native') {
      if (m.busy) return this.serial(m, () => this.outcome(m, 'busy'));
      try {
        await this.ctx.session.wait({ sessionID: m.id }, { signal: AbortSignal.any([this.life.signal, AbortSignal.timeout(250)]) });
      } catch { return this.serial(m, () => this.outcome(m, 'busy')); }
    }
    const prepared = await this.serial(m, async () => {
      const epoch = m.epoch;
      if (this.closed || m.removed) return { outcome: 'closed' };
      if (source !== 'native' && m.busy) return this.outcome(m, 'busy');
      const info = await this.ctx.session.get({ sessionID: m.id });
      if (!this.eligible(info)) return this.outcome(m, 'ineligible');
      await this.ensureState(m, info, { explicit: source === 'manual' });
      const s = await this.reconcile(m, info, { recovering: source !== 'native' });
      if (!s || !this.automaticScope(info, s)) return this.outcome(m, 'out_of_scope');
      if (s.mode !== 'auto') return this.outcome(m, 'locked');
      if (s.pending) return this.outcome(m, 'pending_write');
      const context = readContext(await this.ctx.session.context({ sessionID: m.id }));
      const fallback = source === 'native' && !context.summary && !context.sig.meaningful.length;
      const messages = fallback ? normalizeHookMessages(event?.messages) : context.messages;
      const sig = signatures(messages);
      if (epoch !== m.epoch) return this.outcome(m, 'stale');
      const hasSummary = Boolean(context.summary && meaningfulUserText(context.summary.text));
      const hasAnchor = Boolean(s.anchor && meaningfulUserText(s.anchor.text));
      if (!sig.meaningful.length && !hasSummary && !hasAnchor && !s.tasks.length) return this.outcome(m, 'no_context');
      const fingerprint = source === 'native' ? (fallback ? sig.user : context.basis) : context.fingerprint;
      if (!force && s.attemptFingerprint === fingerprint) return this.outcome(m, 'unchanged');
      const newUsers = sig.meaningful.filter((msg) => !s.evaluatedUserIDs.includes(msg.id));
      const calibration = source !== 'native' && s.initialNamed && !s.calibrated && messages.some((x) => x.role === 'assistant');
      const changedTopic = newUsers.some((x) => isExplicitTopicChange(s.baselineTitle, x.text));
      if (!force && source !== 'native' && s.initialNamed && !calibration) {
        if (this.options.mode === 'initial') return this.outcome(m, 'initial_only');
        if (newUsers.length < this.options.minNewUserTurns && !changedTopic) return this.outcome(m, 'below_threshold');
      }
      if (!force && source !== 'native' && s.lastAttemptAt && !calibration) {
        const remaining = s.lastAttemptAt + this.options.cooldownMs - this.now();
        if (remaining > 0) { this.schedule(m, remaining); return this.outcome(m, 'cooldown'); }
      }
      if (!s.anchor && sig.meaningful.length) s.anchor = {
        id: sig.meaningful[0].id, role: 'user',
        text: truncateGraphemes(redactSensitive(sig.meaningful[0].text), 400).text,
      };
      if (s.anchor && !messages.some((x) => x.id === s.anchor.id)) messages.unshift(s.anchor);
      const prompt = buildNamingPrompt({ messages, currentTitle: s.baselineTitle, tasks: s.tasks,
        summary: context.summary?.text ?? '', mode: s.initialNamed ? 'adaptive' : 'initial' }, this.options).prompt;
      s.lastAttemptAt = this.now();
      s.attemptFingerprint = fingerprint;
      s.lastOutcome = 'generating';
      s.generationAttempts = 0;
      s.generationMaxAttempts = this.options.maxGenerationRetries + 1;
      s.lastGenerationFailure = null;
      s.lastTrigger = source;
      s.contextSources = [
        ...(sig.meaningful.length ? ['user'] : []), ...(hasSummary ? ['compaction'] : []),
        ...(hasAnchor ? ['anchor'] : []), ...(s.tasks.length ? ['tasks'] : []),
      ];
      const model = await selectNamingModel(this.ctx, info, this.options.model);
      s.model = model ?? null; // diagnostic last-used model only, never a fallback
      await this.save(m);
      if (this.closed || epoch !== m.epoch) return this.outcome(m, 'stale');
      return { epoch, state: s, info, prompt, model, fingerprint, basis: context.basis, fallback,
        calibration, hasAssistant: messages.some((x) => x.role === 'assistant'),
        tasks: clone(s.tasks), userIDs: sig.meaningful.map((x) => x.id), source };
    });
    if (prepared.outcome) return prepared;
    const maxAttempts = this.options.maxGenerationRetries + 1;
    // One cancellation controller covers the whole generation phase (requests
    // and backoff); each attempt has its own clearable deadline.
    const runController = new AbortController();
    m.generation = runController;
    let text;
    let failure = null;
    let stopped = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Prepare each request in the short queue; count only actual dispatches
        // below, so cancellation during this save does not count a phantom call.
        const ready = await this.serial(m, async () => {
          if (this.closed || m.removed || m.epoch !== prepared.epoch) return false;
          if (m.state?.mode !== 'auto') return false;
          m.state.generationMaxAttempts = maxAttempts;
          if (attempt === 1) m.state.lastGenerationFailure = null;
          m.state.lastOutcome = 'generating';
          await this.save(m);
          return true;
        });
        // `save` is async; re-check after it settles so an unload or
        // cancellation cannot start one more request.
        if (!ready || this.closed || m.removed || runController.signal.aborted || m.epoch !== prepared.epoch) {
          stopped = 'cancelled';
          break;
        }
        const attemptResult = await this.requestAttempt(m, prepared, runController);
        // Request completion and output validity are separate. A fulfilled
        // request with missing/empty text is validated once, never retried.
        if (attemptResult.ok) { text = attemptResult.text; failure = null; break; }
        failure = attemptResult.failure;
        if (failure === 'cancelled') { stopped = 'cancelled'; break; }
        await this.serial(m, async () => {
          if (this.closed || m.removed || m.epoch !== prepared.epoch || m.state?.mode !== 'auto') return;
          m.state.generationAttempts = attempt;
          m.state.generationMaxAttempts = maxAttempts;
          m.state.lastGenerationFailure = failure;
          if (attempt < maxAttempts) m.state.lastOutcome = 'retry_wait';
          await this.save(m);
        });
        if (this.closed || m.removed || runController.signal.aborted || m.epoch !== prepared.epoch) {
          stopped = 'cancelled';
          break;
        }
        if (attempt === maxAttempts) break;
        // Retry only the same prepared snapshot; re-read it before and after the
        // backoff because a stale snapshot must never be re-sent.
        const early = await this.retryAllowed(m, prepared, runController);
        if (!early.allowed) { stopped = early.outcome; break; }
        try {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1);
          await this.sleep(delay, AbortSignal.any([runController.signal, this.life.signal]));
        } catch { stopped = 'cancelled'; break; }
        const late = await this.retryAllowed(m, prepared, runController);
        if (!late.allowed) { stopped = late.outcome; break; }
      }
    } finally {
      if (m.generation === runController) m.generation = null;
      // Stop plugin-owned work and release derived listeners. A provider that
      // ignores abort may still be running; its late result cannot be committed.
      runController.abort();
    }
    if (stopped) return this.finishGeneration(m, prepared, stopped);
    if (failure) return this.finishGeneration(m, prepared, failure);
    return this.serial(m, async () => {
      if (this.closed || m.removed || m.epoch !== prepared.epoch) return this.finishInSerial(m, prepared, 'stale');
      const info = await this.ctx.session.get({ sessionID: m.id });
      if (!this.eligible(info)) return this.finishInSerial(m, prepared, 'ineligible');
      if (JSON.stringify(await selectNamingModel(this.ctx, info, this.options.model)) !== JSON.stringify(prepared.model)) {
        return this.finishInSerial(m, prepared, 'model_changed');
      }
      const s = await this.reconcile(m, info);
      if (!s || s.mode !== 'auto' || titleOf(info) !== titleOf(prepared.info)) {
        return this.finishInSerial(m, prepared, 'external_rename');
      }
      if (!prepared.fallback && readContext(await this.ctx.session.context({ sessionID: m.id })).basis !== prepared.basis) {
        return this.finishInSerial(m, prepared, 'stale');
      }
      if (this.closed || m.epoch !== prepared.epoch) return this.finishInSerial(m, prepared, 'stale');
      const candidate = parseNamingResult(text, prepared.tasks, { ...this.options, currentTitle: s.baselineTitle });
      if (!candidate.ok) {
        s.lastOutcome = `invalid_${candidate.errors[0]?.code ?? 'output'}`;
        this.log(s.lastOutcome, m.id);
        await this.save(m);
        return { outcome: s.lastOutcome };
      }
      s.lastGenerationFailure = null;
      s.evaluatedUserIDs = [...new Set([...s.evaluatedUserIDs, ...prepared.userIDs])].slice(-512);
      if (prepared.calibration || source !== 'native' && prepared.hasAssistant) s.calibrated = true;
      if (candidate.action !== 'rename' || !candidate.changed) {
        s.tasks = candidate.tasks;
        s.lastOutcome = candidate.action === 'rename' ? 'keep' : candidate.action;
        await this.save(m);
        return { outcome: s.lastOutcome };
      }
      s.pending = { title: candidate.title, tasks: candidate.tasks, at: this.now() };
      await this.save(m);
      if (this.closed || m.epoch !== prepared.epoch) return { outcome: 'stale' };
      if (source === 'native') return { nativeTitle: candidate.title, epoch: prepared.epoch, outcome: 'pending_native' };
      // The public API has no compare-and-swap; re-read immediately before write.
      const last = await this.ctx.session.get({ sessionID: m.id });
      if (this.closed || m.epoch !== prepared.epoch || !this.eligible(last)) return { outcome: 'stale' };
      if (titleOf(last) !== s.baselineTitle) {
        await this.lockState(m, titleOf(last), 'external_rename');
        return { outcome: 'external_rename' };
      }
      try {
        await this.ctx.session.update({ sessionID: m.id, title: candidate.title });
        const written = await this.ctx.session.get({ sessionID: m.id });
        await this.reconcile(m, written, { recovering: true });
        return { outcome: s.lastOutcome };
      } catch {
        // A transport failure may have followed a successful write. Reconcile on
        // the next event/recovery instead of blindly overwriting or retrying.
        s.lastOutcome = 'write_uncertain';
        await this.save(m);
        return { outcome: 'write_uncertain' };
      }
    });
  }

  /**
   * One request attempt with an actively cancelable deadline. The timer is
   * always cleared and the abort listener removed before this returns.
   */
  async requestAttempt(m, prepared, runController) {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Timed out', 'TimeoutError')),
      this.options.timeoutMs,
    );
    timer.unref?.();
    const signal = AbortSignal.any([runController.signal, this.life.signal, deadline.signal]);
    let onAbort;
    try {
      if (signal.aborted) return { failure: this.classifyGenerationFailure({ m, prepared, runController, deadline }) };
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const request = Promise.resolve().then(() => {
        // A run cancelled before dispatch must not issue a real request.
        if (signal.aborted || runController.signal.aborted || this.closed || m.removed || m.epoch !== prepared.epoch) {
          throw signal.reason ?? abortError();
        }
        // Diagnostic-only synchronous counter, immediately before the API call.
        // In-flight status reads this live value; the next state save persists it.
        prepared.state.generationAttempts += 1;
        return this.ctx.experimental.generate.text(
          { prompt: prepared.prompt, ...(prepared.model ? { model: prepared.model } : {}) }, { signal },
        );
      });
      // A request that loses the race (e.g. late provider failure) is still handled.
      request.catch(() => {});
      const response = await Promise.race([request, aborted]);
      return { ok: true, text: response?.text };
    } catch {
      return { failure: this.classifyGenerationFailure({ m, prepared, runController, deadline }) };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // Release this attempt's signal on every exit, not only on timeout or
      // when the entire retry chain ends. Each next request gets a fresh one.
      deadline.abort();
    }
  }

  /** Only a genuine request failure/timeout is retryable; cancellation is separate. */
  classifyGenerationFailure({ m, prepared, runController, deadline }) {
    if (this.closed || this.life.signal.aborted) return 'cancelled';
    if (m.epoch !== prepared.epoch || runController.signal.aborted) return 'cancelled';
    if (deadline.signal.aborted) return 'generation_timeout';
    return 'model_failed';
  }

  /**
   * Record a stop reason for the current evaluation without overwriting newer
   * outcomes. Only a still-pending state owned by this evaluation may change.
   */
  applyFinish(m, prepared, outcome) {
    if (this.closed || m.removed || !m.state) return false;
    // A model-selection event clears the fingerprint to allow the next run.
    // The single-flight state identity still owns this cancelled run's cleanup.
    if (m.state !== prepared.state) return false;
    if (m.state.mode !== 'auto') return false;
    if (!['generating', 'retry_wait'].includes(m.state.lastOutcome)) return false;
    m.state.lastOutcome = outcome;
    return true;
  }

  /** For callers already inside `serial` on the same machine. */
  async finishInSerial(m, prepared, outcome) {
    const failure = outcome === 'model_failed' || outcome === 'generation_timeout';
    const cancelled = () => this.closed || m.removed || m.epoch !== prepared.epoch;
    if (failure && cancelled()) outcome = 'cancelled';
    if (this.applyFinish(m, prepared, outcome)) {
      await this.save(m);
      // cancel() runs outside the serial queue so it can interrupt I/O. If it
      // wins while the terminal failure is being saved, report cancellation and
      // leave any queued lock/unlock operation free to write its newer state.
      if (failure && cancelled()) {
        if (!this.closed && !m.removed && m.state === prepared.state
            && m.state.mode === 'auto' && m.state.lastOutcome === outcome) {
          m.state.lastOutcome = 'cancelled';
          await this.save(m);
        }
        outcome = 'cancelled';
      }
    }
    return { outcome };
  }

  finishGeneration(m, prepared, outcome) {
    return this.serial(m, () => this.finishInSerial(m, prepared, outcome));
  }

  /**
   * Re-read everything the prepared request depended on. Used between attempts
   * so an event-less change to title/model/context/scope stops the retry chain.
   * Every await is followed by a re-check so a cancellation in any gap loses.
   */
  retryAllowed(m, prepared, runController) {
    return this.serial(m, async () => {
      const stop = () => {
        if (this.closed || m.removed) return 'closed';
        if (runController.signal.aborted || m.epoch !== prepared.epoch) return 'cancelled';
        if (m.state?.mode !== 'auto') return 'locked';
        return null;
      };
      let why = stop();
      if (why) return { allowed: false, outcome: why };
      let info;
      try { info = await this.ctx.session.get({ sessionID: m.id }); }
      catch { return { allowed: false, outcome: 'stale' }; }
      why = stop();
      if (why) return { allowed: false, outcome: why };
      if (!this.eligible(info)) return { allowed: false, outcome: 'ineligible' };
      if (titleOf(info) !== titleOf(prepared.info)) return { allowed: false, outcome: 'external_rename' };
      let model;
      try { model = await selectNamingModel(this.ctx, info, this.options.model); }
      catch { return { allowed: false, outcome: 'stale' }; }
      why = stop();
      if (why) return { allowed: false, outcome: why };
      if (JSON.stringify(model) !== JSON.stringify(prepared.model)) return { allowed: false, outcome: 'model_changed' };
      if (!prepared.fallback) {
        let snapshot;
        try { snapshot = await this.ctx.session.context({ sessionID: m.id }); }
        catch { return { allowed: false, outcome: 'stale' }; }
        why = stop();
        if (why) return { allowed: false, outcome: why };
        if (readContext(snapshot).basis !== prepared.basis) return { allowed: false, outcome: 'stale' };
      }
      why = stop();
      if (why) return { allowed: false, outcome: why };
      return { allowed: true };
    });
  }

  async command(operation, id) {
    if (this.closed) throw new Error('自动命名插件正在卸载，请稍后重试。');
    const m = this.machine(id);
    if (operation !== 'refresh') this.cancel(m);
    const result = await this.serial(m, async () => {
      const info = await this.ctx.session.get({ sessionID: id });
      if (!this.eligible(info)) throw new Error('该会话不在当前插件范围内，或已归档。');
      let s = await this.state(m);
      if (operation === 'lock') {
        m.state = s ?? initialState(info, 'explicit_lock');
        await this.lockState(m, titleOf(info), 'explicit_lock');
      } else if (operation === 'unlock') {
        m.state = s ?? initialState(info, 'explicit_unlock');
        s = m.state;
        s.mode = 'auto'; s.reason = 'explicit_unlock'; s.baselineTitle = titleOf(info);
        if (info.fork) s.forkAdopted = true;
        s.pending = null; s.attemptFingerprint = ''; s.lastOutcome = 'unlocked';
        await this.save(m);
      } else {
        s = await this.ensureState(m, info, { explicit: true });
        s = await this.reconcile(m, info);
        if (s.mode === 'locked') throw new Error('当前标题已锁定（人工改名与锁定命令共用此锁），请先执行 /autotitle-unlock。');
        if (info.fork) { s.forkAdopted = true; await this.save(m); }
        if (m.busy) throw new Error('会话仍在执行，请在本轮结束后重试。');
      }
      return { mode: m.state.mode, reason: m.state.reason };
    });
    if (operation !== 'refresh') return result;
    if (m.flight) await m.flight;
    const evaluation = await this.evaluate(id, { source: 'manual', force: true });
    if (!['renamed', 'keep', 'defer'].includes(evaluation.outcome)) {
      const reasons = {
        no_context: '没有可用于命名的用户需求、已完成的压缩摘要或已保存任务，请先补充需求',
        busy: '会话仍在执行，请在本轮结束后重试',
        locked: '标题已锁定，请先执行 /autotitle-unlock',
        stale: '评估期间上下文发生变化，请在本轮结束后重试',
        model_changed: '评估期间切换了模型，请重试',
        pending_write: '正在等待上一次标题写入确认，请稍后重试',
        prompt_budget_exceeded: '命名上下文预算不足，请提高 maxContextTokens',
        ineligible: '会话已归档或已移出当前插件范围',
        out_of_scope: '该会话不在自动命名范围内',
        model_failed: '本次生成尝试已耗尽，最后一次请求失败，已保留原名称',
        generation_timeout: '本次生成尝试已耗尽，最后一次请求超时，已保留原名称',
        cancelled: '命名请求已取消（会话被锁定、修改或切换）',
      };
      throw new Error(`${reasons[evaluation.outcome] ?? '本次自动命名未提交'}（${evaluation.outcome}）。已保留原名称；终端版可用 /autotitle-status 查看状态，其他客户端可调用 autotitle_status 工具。`);
    }
    return evaluation;
  }

  async status(id) {
    const info = await this.ctx.session.get({ sessionID: id });
    if (!this.owns(info)) throw new Error('会话不属于当前 location。');
    const m = this.machines.get(id);
    const read = async () => {
      // Pure snapshot: do not adopt a session or even populate/migrate its
      // in-memory machine when querying. Legacy scope normalization is local.
      const value = m?.loaded ? m.state : await this.ctx.storage.get(keyOf(id));
      const s = value?.schema === 1 ? clone(value) : null;
      if (s?.mode === 'locked' && s.reason === 'fork_not_adopted') {
        s.mode = 'auto'; s.reason = 'default_unlocked'; s.pending = null; s.lastOutcome = 'not_evaluated';
      }
      const managed = this.automaticScope(info, s);
      return s ? { managed, tracked: true, mode: s.mode, locked: s.mode === 'locked', reason: s.reason, lastOutcome: s.lastOutcome,
        lastAttemptAt: s.lastAttemptAt, taskCount: s.tasks.length, initialNamed: s.initialNamed,
        calibrated: s.calibrated, pending: Boolean(s.pending), lastModel: s.model,
        lastTrigger: s.lastTrigger ?? null, contextSources: s.contextSources ?? [],
        generationAttempts: s.generationAttempts ?? 0,
        generationMaxAttempts: s.generationMaxAttempts ?? 0,
        lastGenerationFailure: s.lastGenerationFailure ?? null }
        : { managed, tracked: false, mode: 'auto', locked: false,
          reason: managed ? 'default_unlocked' : 'out_of_scope', lastOutcome: 'not_evaluated' };
    };
    return m ? this.serial(m, read) : read();
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.life.abort();
    for (const m of this.machines.values()) this.cancel(m);
    await Promise.allSettled(this.registrations.map((r) => r.dispose()));
    await Promise.allSettled([...this.machines.values()].map((m) => m.chain));
  }
}
