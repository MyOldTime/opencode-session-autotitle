/**
 * opencode-session-autotitle / title format (pure, dependency-free).
 *
 * This module owns the *only* title renderer and the format-aware equivalence
 * helpers. `naming.mjs` re-exports the public pieces, so callers keep importing
 * from one place and there is no import cycle.
 *
 * Current grammar:
 *   single task      [对象](动作)任务
 *   same object      [对象](动作)任务1;(动作)任务2
 *   different objects [对象1](动作)任务1 | [对象2](动作)任务2
 *
 * Structural punctuation is ASCII `[]();`; the fragment separator is exactly
 * one space, a pipe and one space (` | `). Layout whitespace is not semantic.
 *
 * Legacy (pre-0.1.3) titles used `subject｜verb+target；...`. `legacyTitleKey`
 * and `migrateLegacyTitle` exist only to recognise and migrate such titles; the
 * current `titleKey` never erases brackets, parentheses or technical symbols.
 */

/** Structural tokens of the current title grammar. */
export const TITLE_SEPARATORS = Object.freeze(['[', ']', '(', ')', ';', '|']);

const FRAGMENT_SEPARATOR = ' | ';
const TASK_SEPARATOR = ';';

// Subjects may carry natural parentheses (`API(v2)`); square brackets and
// separators stay reserved for the frame. Fullwidth structural punctuation is
// not canonical output and therefore makes a title non-current.
const OPEN_RE = /^\[([^[\]［］（）|｜;；]+)\]\(([^()[\]［］（）|｜;；]+)\)(.+)$/u;
const LATER_TASK_RE = /^\(([^()[\]［］（）|｜;；]+)\)(.+)$/u;

/**
 * Parse a title in the strict current grammar. Returns `null` for anything
 * else; used for format detection only, never as a source of task data.
 * Exact ` | ` spacing and ASCII structural punctuation are required. Targets
 * are opaque text between reserved separators: `handlers[0](event)` is code,
 * not a second object frame. Missing object separators are corrected by
 * comparing with the title rendered from the structured task ledger, never by
 * guessing what a bracket expression inside a target means.
 */
export function parseTitleFormat(title) {
  if (typeof title !== 'string' || !title.trim()) return null;
  if (/\p{Cc}/u.test(title)) return null;
  const fragments = title.split(FRAGMENT_SEPARATOR);
  if (fragments.length === 0) return null;
  const parsed = [];
  for (const fragment of fragments) {
    if (fragment !== fragment.trim()) return null;
    const match = OPEN_RE.exec(fragment);
    if (!match) return null;
    const [, subject, verb, body] = match;
    if (!subject.trim() || !verb.trim()) return null;
    if (!body || /[|｜；［］（）]/u.test(body)) return null;
    const segments = body.split(TASK_SEPARATOR);
    if (segments.some((segment) => !segment.trim())) return null;
    for (let index = 1; index < segments.length; index += 1) {
      const later = LATER_TASK_RE.exec(segments[index]);
      if (!later || !later[1].trim() || !later[2].trim()) return null;
    }
    parsed.push({ subject, verb, targets: segments });
  }
  return parsed;
}

/** True when `title` already follows the current `[对象](动作)任务` grammar. */
export function isCurrentTitleFormat(title) {
  return parseTitleFormat(title) !== null;
}

/**
 * Legacy titles are the only ones the program may migrate on `keep`: they must
 * carry the old `｜` structural separator. A free-form manual title is never
 * silently rewritten.
 */
export function isLegacyTitleFormat(title) {
  return typeof title === 'string' && title.includes('｜') && !isCurrentTitleFormat(title);
}

function groupBySubject(tasks) {
  const groups = [];
  for (const task of tasks) {
    const group = groups.find((item) => item.subject === task.subject);
    if (group) group.tasks.push(task);
    else groups.push({ subject: task.subject, tasks: [task] });
  }
  return groups;
}

/**
 * The single current renderer. Rendering is program-side only; the model never
 * supplies a title. Returns '' when the subject count exceeds the configured
 * fragment limit (the caller fails closed).
 */
export function renderTitleTasks(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '';
  const maxFragments = Number.isInteger(options?.maxDisplayFragments) ? options.maxDisplayFragments : 2;
  const groups = groupBySubject(list);
  if (groups.length > maxFragments) return '';
  return groups
    .map((group) => `[${group.subject}]${group.tasks.map((task) => `(${task.verb})${task.target}`).join(TASK_SEPARATOR)}`)
    .join(FRAGMENT_SEPARATOR);
}

/** Legacy renderer, retained solely to recognise old titles for migration. */
export function renderLegacyTitle(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '';
  const maxFragments = Number.isInteger(options?.maxDisplayFragments) ? options.maxDisplayFragments : 2;
  const groups = groupBySubject(list);
  if (groups.length > maxFragments) return '';
  return groups
    .map((group) => `${group.subject}｜${group.tasks.map((task) => `${task.verb}${task.target}`).join('；')}`)
    .join('；');
}

/**
 * Equivalence key for current titles: NFKC plus whitespace removal only.
 * Brackets, parentheses, `+`, `#`, `.`, `-`, `_`, `/` and casing are preserved,
 * so `foo()`/`foo`, `a[0]`/`a0`, `C++`/`C`, `C#` and `node.js`/`nodejs` differ.
 */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000]+/gu, '');
}

/**
 * Legacy equivalence key (pre-0.1.3). It erases old layout punctuation,
 * including Chinese separators, and is exported only for historical
 * compatibility. Migration must NOT use it: see `legacyMigrationKey`.
 */
export function legacyTitleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000]+/gu, '')
    .replace(/[｜|；;，,、。！!？?：:・·…—–「」『』()（）[\]【】"'“”‘’]+/gu, '')
    .replace(/^[.．]+|[.．]+$/gu, '');
}

export function titlesEquivalent(a, b) {
  return titleKey(a) === titleKey(b);
}

/**
 * Strict migration comparison: NFKC and layout whitespace only. Unlike the
 * legacy key it keeps `()[]`, `+`, `#`, `.`, `-`, `_`, `/` and the old
 * structural boundaries, so `foo` vs `foo()`, `a0` vs `a[0]`, `C` vs `C++`
 * never count as the same title.
 */
function legacyMigrationKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000]+/gu, '');
}

/**
 * Decide whether a `keep` answer can be turned into a pure format migration.
 * Returns the new title only when the stored ledger renders, under the legacy
 * grammar, to exactly the same content as the current title (technical
 * punctuation preserved). Otherwise null: arbitrary keeps, defers and manual
 * titles are left untouched.
 */
export function migrateLegacyTitle(currentTitle, tasks, options = {}) {
  if (!isLegacyTitleFormat(currentTitle)) return null;
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return null;
  const legacy = renderLegacyTitle(list, options);
  if (!legacy) return null;
  if (legacyMigrationKey(currentTitle) !== legacyMigrationKey(legacy)) return null;
  return renderTitleTasks(list, options) || null;
}
