import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFICATION_CONTEXT,
  FINDING_MARKER,
  GATE_CONTEXT,
  baseKey,
  decide,
  findSigners,
  globToRegExp,
  keepWriters,
  parseClassification,
  parseFixedThreads,
  pathRules,
  prepareRound,
  publishClassification,
  runGate,
  summarizeReviews,
  threadsToResolve,
  validatePolicy,
} from '../skills/setup/templates/github/review-flow/review-flow.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1111111111111111111111111111111111111111';
const MAIN = baseKey('main');
const human = (login) => ({ login, type: 'User' });

const policy = () => ({
  approvals: { low: 0, medium: 1, high: 2 },
  max_rounds: 3,
  trusted_authors: ['alice'],
  agent_accounts: ['agent-account'],
  floors: { high: ['**/auth/**'], medium: ['**/cache/**'] },
  always_human: ['.github/**', '**/CLAUDE.md'],
});

const input = (overrides = {}) => ({
  policy: policy(),
  pr: { headSha: HEAD, draft: false, author: 'alice' },
  files: [{ filename: 'docs/a.md' }],
  classification: { tier: 'low', human: false },
  approvers: [],
  signers: [],
  changesRequestedBy: [],
  ...overrides,
});

test('globs match directories at any depth and stay within path segments', () => {
  assert.ok(globToRegExp('**/auth/**').test('auth/login.ts'));
  assert.ok(globToRegExp('**/auth/**').test('src/auth/deep/login.ts'));
  assert.ok(!globToRegExp('**/auth/**').test('src/author/login.ts'));
  assert.ok(globToRegExp('**/CLAUDE.md').test('CLAUDE.md'));
  assert.ok(globToRegExp('**/CLAUDE.md').test('src/payments/CLAUDE.md'));
  assert.ok(globToRegExp('*.md').test('a.md'));
  assert.ok(!globToRegExp('*.md').test('docs/a.md'));
  assert.ok(!globToRegExp('a.md').test('axmd'));
});

test('a low-risk change from a trusted author needs no person', () => {
  assert.equal(decide(input()).state, 'success');
});

test('a draft stays pending', () => {
  assert.equal(decide(input({ pr: { headSha: HEAD, draft: true, author: 'alice' } })).state, 'pending');
});

test('without classification a person can still approve, as for any medium change', () => {
  const waiting = decide(input({ classification: null }));
  assert.equal(waiting.state, 'pending');
  assert.match(waiting.description, /^medium: 0\/1 human approvals \(no AI review\)/);
  assert.equal(decide(input({ classification: null, approvers: ['bob'] })).state, 'success');
});

test('the pending message asks for a sign-off on the full commit', () => {
  const { description } = decide(input({ classification: null }));
  assert.ok(description.endsWith(`/signoff ${HEAD}`));
  assert.ok(description.length <= 140);
});

test('a path floor overrides a lower model tier', () => {
  const result = decide(input({ files: [{ filename: 'src/auth/x.ts' }], approvers: ['bob'] }));
  assert.equal(result.state, 'pending');
  assert.match(result.description, /^high: 1\/2/);
});

test('the model can raise the tier above the floor', () => {
  const result = decide(input({ classification: { tier: 'high', human: false }, approvers: ['bob', 'carol'] }));
  assert.equal(result.state, 'success');
  assert.match(result.description, /^high/);
});

test('renaming a file out of a sensitive path still counts', () => {
  const rules = pathRules(policy(), [{ filename: 'src/x.ts', previous_filename: 'src/auth/x.ts' }]);
  assert.equal(rules.floor, 'high');
});

test('a truncated file list is treated as high risk', () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` }));
  assert.equal(pathRules(policy(), files).floor, 'high');
});

test('human_required and always_human paths need a person even on low', () => {
  assert.equal(decide(input({ classification: { tier: 'low', human: true } })).state, 'pending');
  assert.equal(decide(input({ files: [{ filename: '.github/workflows/x.yml' }] })).state, 'pending');
  assert.equal(decide(input({ files: [{ filename: 'src/payments/CLAUDE.md' }] })).state, 'pending');
});

test('an untrusted author on low needs a person and cannot sign off', () => {
  assert.equal(decide(input({ pr: { headSha: HEAD, draft: false, author: 'mallory' } })).state, 'pending');
  const comments = [{ body: `/signoff ${HEAD}`, user: human('mallory') }];
  assert.deepEqual(findSigners(comments, HEAD, policy()), []);
});

test('the same person approving and signing off counts once', () => {
  const result = decide(input({ classification: { tier: 'high', human: false }, approvers: ['Bob'], signers: ['bob'] }));
  assert.match(result.description, /^high: 1\/2/);
});

test('requested changes block until cleared', () => {
  assert.match(decide(input({ changesRequestedBy: ['bob'] })).description, /Changes requested/);
});

test('approvals count only on the head commit and only from people', () => {
  const review = (login, state, commit_id, submitted_at, type = 'User') => ({
    user: { login, type }, state, commit_id, submitted_at,
  });
  const { approvers, changesRequestedBy } = summarizeReviews([
    review('stale', 'APPROVED', OLD, '2026-01-01'),
    review('good', 'APPROVED', HEAD, '2026-01-01'),
    review('claude[bot]', 'APPROVED', HEAD, '2026-01-01', 'Bot'),
    review('agent-account', 'APPROVED', HEAD, '2026-01-01'),
    review('undone', 'APPROVED', HEAD, '2026-01-01'),
    review('undone', 'DISMISSED', HEAD, '2026-01-02'),
    review('blocker', 'CHANGES_REQUESTED', OLD, '2026-01-01'),
    review('alice', 'APPROVED', HEAD, '2026-01-01'),
  ], HEAD, 'alice', policy());
  assert.deepEqual(approvers, ['good']);
  assert.deepEqual(changesRequestedBy, ['blocker']);
});

test('a later comment-only review does not cancel an approval', () => {
  const reviews = [
    { user: human('bob'), state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01' },
    { user: human('bob'), state: 'COMMENTED', commit_id: HEAD, submitted_at: '2026-01-02' },
  ];
  assert.deepEqual(summarizeReviews(reviews, HEAD, 'alice', policy()).approvers, ['bob']);
});

test('only people with write access count as reviewers', async () => {
  const permissions = { writer: 'write', admin: 'admin', reader: 'read', maintainer: 'read' };
  const roles = { maintainer: 'maintain' };
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => {
          if (username === 'stranger') throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { permission: permissions[username], role_name: roles[username] ?? permissions[username] } };
        },
      },
    },
  };
  const logins = ['writer', 'admin', 'reader', 'maintainer', 'stranger'];
  assert.deepEqual(await keepWriters(github, 'o', 'r', logins), ['writer', 'admin', 'maintainer']);
});

test('sign-off requires a trusted person and the full head commit', () => {
  const signers = (comments) => findSigners(comments, HEAD, policy());
  assert.deepEqual(signers([{ body: `/signoff ${HEAD}`, user: human('alice') }]), ['alice']);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD.toUpperCase()}`, user: human('Alice') }]), ['Alice']);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD.slice(0, 7)}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD.slice(0, 39)}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `/signoff ${OLD}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: '/signoff', user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `please /signoff ${HEAD}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD}`, user: { login: 'alice', type: 'Bot' } }]), []);
});

test('an invalid policy is rejected', () => {
  assert.throws(() => validatePolicy({ ...policy(), approvals: { low: 0, medium: '1', high: 2 } }), /medium/);
  assert.throws(() => validatePolicy({ ...policy(), max_rounds: 0 }), /max_rounds/);
  assert.throws(() => validatePolicy({ ...policy(), always_human: undefined }), /required/);
});

test('classification descriptions are parsed strictly', () => {
  assert.deepEqual(parseClassification(`tier=high human=1 round=2 capped=0 base=${MAIN}`), { tier: 'high', human: true, round: 2, capped: false, base: MAIN });
  assert.equal(parseClassification('tier=high human=1 round=2 capped=0'), null);
  assert.equal(parseClassification(`tier=none human=1 round=2 capped=0 base=${MAIN}`), null);
  assert.equal(parseClassification(`tier=low human=0 round=1 capped=0 base=${MAIN} extra`), null);
});

test('the shipped policy template is valid', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '../skills/setup/templates/github/review-flow/risk-policy.json');
  assert.ok(validatePolicy(JSON.parse(readFileSync(path, 'utf8'))));
});

test('fixed thread IDs are read defensively', () => {
  assert.deepEqual(parseFixedThreads(''), []);
  assert.deepEqual(parseFixedThreads('not json'), []);
  assert.deepEqual(parseFixedThreads('{"fixed_threads":"T1"}'), []);
  assert.deepEqual(parseFixedThreads('{"fixed_threads":["T1",2]}'), ['T1']);
});

test('only open, outdated reviewer threads are resolved', () => {
  const threads = [
    { id: 'T1', resolved: false, outdated: true },
    { id: 'T2', resolved: false, outdated: false },
    { id: 'T3', resolved: true, outdated: true },
    { id: 'T4', resolved: false, outdated: true },
  ];
  assert.deepEqual(threadsToResolve(threads, ['T1', 'T2', 'T3', 'T9']).map((t) => t.id), ['T1']);
});

function threadNode(id, { bot = true, marker = true, resolved = false, outdated = false } = {}) {
  return {
    id,
    isResolved: resolved,
    isOutdated: outdated,
    path: 'a.js',
    line: 1,
    comments: { nodes: [{ body: marker ? `bug ${FINDING_MARKER}` : 'bug', author: { login: bot ? 'claude' : 'bob', __typename: bot ? 'Bot' : 'User' } }] },
  };
}

function toolkit({
  eventName = 'pull_request_target',
  payload,
  statusesByRef = {},
  commits = [],
  files = [{ filename: 'a.md' }],
  reviews = [],
  comments = [],
  author = 'alice',
  baseRef = 'main',
  writers = ['bob', 'carol'],
  threadPages = [[]],
  openPulls = [],
  env = {},
}) {
  const workspace = mkdtempSync(join(tmpdir(), 'review-flow-'));
  mkdirSync(join(workspace, '.github/review-flow'), { recursive: true });
  writeFileSync(join(workspace, '.github/review-flow/risk-policy.json'), JSON.stringify(policy()));
  Object.assign(process.env, { GITHUB_WORKSPACE: workspace, FIXED_REVIEW: '', FIXED_SECURITY: '', ...env });

  const created = [];
  const posted = [];
  const resolved = [];
  const evaluated = [];
  const outputs = {};
  const rest = {
    repos: {
      listCommitStatusesForRef: async ({ ref }) => statusesByRef[ref] ?? [],
      createCommitStatus: async (status) => { created.push(status); },
      getCollaboratorPermissionLevel: async ({ username }) => ({ data: { permission: writers.includes(username) ? 'write' : 'read' } }),
    },
    pulls: {
      get: async ({ pull_number }) => {
        evaluated.push(pull_number);
        return { data: { draft: false, user: { login: author }, head: { sha: HEAD }, base: { ref: baseRef } } };
      },
      list: async () => openPulls,
      listFiles: async () => files,
      listReviews: async () => reviews,
      listCommits: async () => commits,
    },
    issues: {
      listComments: async () => comments,
      createComment: async (comment) => { posted.push(comment); },
    },
  };
  const graphql = async (query, variables) => {
    if (query.includes('resolveReviewThread')) {
      resolved.push(variables.id);
      return {};
    }
    const index = variables.cursor ? Number(variables.cursor) : 0;
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threadPages[index],
            pageInfo: { hasNextPage: index + 1 < threadPages.length, endCursor: String(index + 1) },
          },
        },
      },
    };
  };
  const summary = { addHeading: () => summary, addRaw: () => summary, addList: () => summary, write: async () => {} };
  return {
    created,
    posted,
    resolved,
    evaluated,
    outputs,
    github: { rest, graphql, paginate: (fn, args) => fn(args) },
    context: { eventName, payload, repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1 },
    core: { info() {}, warning() {}, setOutput: (key, value) => { outputs[key] = value; }, summary },
  };
}

const classified = (description, login = 'github-actions[bot]') => [
  { context: CLASSIFICATION_CONTEXT, description, creator: { login } },
];
const LOW = `tier=low human=0 round=1 capped=0 base=${MAIN}`;

test('runGate reads the classification and sets the status on the head commit', async () => {
  const kit = toolkit({ payload: { pull_request: { number: 7 } }, statusesByRef: { [HEAD]: classified(LOW) } });
  await runGate(kit);
  assert.equal(kit.created.length, 1);
  assert.equal(kit.created[0].context, GATE_CONTEXT);
  assert.equal(kit.created[0].sha, HEAD);
  assert.equal(kit.created[0].state, 'success');
});

test('runGate ignores a classification status from any other account', async () => {
  const kit = toolkit({ payload: { pull_request: { number: 7 } }, statusesByRef: { [HEAD]: classified(LOW, 'mallory') } });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'pending');
});

test('a classification made against another base branch does not count', async () => {
  const kit = toolkit({ payload: { pull_request: { number: 7 } }, statusesByRef: { [HEAD]: classified(LOW) }, baseRef: 'dev' });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'pending');
  assert.match(kit.created[0].description, /no AI review/);
});

test('an approval from someone without write access does not count', async () => {
  const reviews = [{ user: human('drive-by'), state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-01-01' }];
  const medium = `tier=medium human=0 round=1 capped=0 base=${MAIN}`;
  const kit = toolkit({ payload: { pull_request: { number: 7 } }, statusesByRef: { [HEAD]: classified(medium) }, reviews });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'pending');

  const blocker = [{ user: human('drive-by'), state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-01-01' }];
  const blocked = toolkit({ payload: { pull_request: { number: 7 } }, statusesByRef: { [HEAD]: classified(LOW) }, reviews: blocker });
  await runGate(blocked);
  assert.equal(blocked.created[0].state, 'success');
});

test('runGate works from a sign-off comment event', async () => {
  const kit = toolkit({
    eventName: 'issue_comment',
    payload: { issue: { number: 7 } },
    statusesByRef: { [HEAD]: classified(`tier=medium human=0 round=1 capped=0 base=${MAIN}`) },
    comments: [{ body: `/signoff ${HEAD}`, user: human('alice') }],
  });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'success');
});

test('a review event reaches the gate through workflow_run, including from forks', async () => {
  const linked = toolkit({ eventName: 'workflow_run', payload: { workflow_run: { head_sha: HEAD, pull_requests: [{ number: 7 }] } } });
  await runGate(linked);
  assert.deepEqual(linked.evaluated, [7]);

  const fork = toolkit({
    eventName: 'workflow_run',
    payload: { workflow_run: { head_sha: HEAD, pull_requests: [] } },
    openPulls: [{ number: 8, head: { sha: HEAD } }, { number: 9, head: { sha: OLD } }],
  });
  await runGate(fork);
  assert.deepEqual(fork.evaluated, [8]);
  assert.equal(fork.created[0].sha, HEAD);
});

test('a failure to set the status is not swallowed', async () => {
  const kit = toolkit({ payload: { pull_request: { number: 7 } } });
  kit.github.rest.repos.createCommitStatus = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await assert.rejects(runGate(kit), /Forbidden/);
});

test('runGate passes merge groups through on the group commit', async () => {
  const kit = toolkit({ eventName: 'merge_group', payload: { merge_group: { head_sha: OLD } } });
  await runGate(kit);
  assert.equal(kit.created[0].sha, OLD);
  assert.equal(kit.created[0].state, 'success');
});

test('prepareRound starts at one and continues from the last reviewed commit', async () => {
  const first = toolkit({ payload: { pull_request: { number: 7, head: { sha: HEAD } } }, commits: [{ sha: HEAD }] });
  await prepareRound(first);
  assert.deepEqual(first.outputs, { round: '1', since: '', capped: 'false', threads: '[]' });

  const next = toolkit({
    payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    commits: [{ sha: OLD }, { sha: HEAD }],
    statusesByRef: { [OLD]: classified(`tier=low human=0 round=3 capped=0 base=${MAIN}`) },
  });
  await prepareRound(next);
  assert.equal(next.outputs.round, '4');
  assert.equal(next.outputs.since, OLD);
  assert.equal(next.outputs.capped, 'true');
});

test('a re-run on the same commit does not use up a round', async () => {
  const kit = toolkit({
    payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    commits: [{ sha: HEAD }],
    statusesByRef: { [HEAD]: classified(LOW) },
  });
  await prepareRound(kit);
  assert.equal(kit.outputs.round, '1');
});

test('prepareRound passes on open and resolved reviewer threads only, across pages', async () => {
  const kit = toolkit({
    payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    commits: [{ sha: HEAD }],
    threadPages: [
      [threadNode('T1'), threadNode('T2', { bot: false })],
      [threadNode('T3', { resolved: true }), threadNode('T4', { marker: false })],
    ],
  });
  await prepareRound(kit);
  const threads = JSON.parse(kit.outputs.threads);
  assert.deepEqual(threads.map((t) => [t.id, t.resolved]), [['T1', false], ['T3', true]]);
});

const payload = { pull_request: { number: 7, head: { sha: HEAD }, base: { ref: 'main' } } };

test('publishClassification stores the result and then evaluates the gate', async () => {
  const kit = toolkit({ payload, env: { CLASSIFICATION: '{"tier":"low","human_required":false,"reasons":["docs"]}', ROUND: '1', CAPPED: 'false' } });
  const { rest } = kit.github;
  const stored = [];
  const create = rest.repos.createCommitStatus;
  rest.repos.createCommitStatus = async (status) => {
    if (status.context === CLASSIFICATION_CONTEXT) stored.push({ context: status.context, description: status.description, creator: { login: 'github-actions[bot]' } });
    await create(status);
  };
  rest.repos.listCommitStatusesForRef = async () => stored;
  await publishClassification(kit);
  assert.deepEqual(kit.created.map((status) => status.context), [CLASSIFICATION_CONTEXT, GATE_CONTEXT]);
  assert.equal(kit.created[0].description, LOW);
  assert.equal(kit.created[1].state, 'success');
  assert.equal(kit.posted.length, 0);
});

test('publishClassification resolves only fixed threads whose code changed', async () => {
  const kit = toolkit({
    payload,
    threadPages: [[
      threadNode('T1', { outdated: true }),
      threadNode('T2', { outdated: false }),
      threadNode('T3', { outdated: true, bot: false }),
    ]],
    env: {
      CLASSIFICATION: '{"tier":"low","human_required":false,"reasons":[]}',
      ROUND: '2',
      CAPPED: 'false',
      FIXED_REVIEW: '{"fixed_threads":["T1","T2"]}',
      FIXED_SECURITY: '{"fixed_threads":["T3"]}',
    },
  });
  await publishClassification(kit);
  assert.deepEqual(kit.resolved, ['T1']);
});

test('past the cap a person is required and the author is told once', async () => {
  const atCap = toolkit({ payload, env: { CLASSIFICATION: '{"tier":"low","human_required":false,"reasons":[]}', ROUND: '4', CAPPED: 'true' } });
  await publishClassification(atCap);
  assert.equal(atCap.created[0].description, `tier=low human=1 round=4 capped=1 base=${MAIN}`);
  assert.equal(atCap.posted.length, 1);

  const later = toolkit({ payload, env: { CLASSIFICATION: '{"tier":"low","human_required":false,"reasons":[]}', ROUND: '5', CAPPED: 'true' } });
  await publishClassification(later);
  assert.equal(later.posted.length, 0);
});

test('malformed model output publishes nothing', async () => {
  const kit = toolkit({ payload, env: { CLASSIFICATION: '{"tier":"none","human_required":false}', ROUND: '1', CAPPED: 'false' } });
  await assert.rejects(publishClassification(kit), /Invalid classification/);
  assert.equal(kit.created.length, 0);
});
