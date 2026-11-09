import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFICATION_CONTEXT,
  GATE_CONTEXT,
  decide,
  findSigners,
  globToRegExp,
  parseClassification,
  pathRules,
  prepareRound,
  publishClassification,
  runGate,
  summarizeReviews,
  validatePolicy,
} from '../skills/setup/templates/github/review-flow/review-flow.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1111111111111111111111111111111111111111';
const human = (login) => ({ login, type: 'User' });

const policy = () => ({
  approvals: { low: 0, medium: 1, high: 2 },
  max_rounds: 3,
  trusted_authors: ['alice'],
  agent_accounts: ['agent-account'],
  floors: { high: ['**/auth/**'], medium: ['**/cache/**'] },
  always_human: ['.github/**'],
});

const pr = (overrides = {}) => ({
  headSha: HEAD,
  draft: false,
  author: 'alice',
  headRepo: 'o/r',
  baseRepo: 'o/r',
  ...overrides,
});

const input = (overrides = {}) => ({
  policy: policy(),
  pr: pr(),
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
  assert.ok(globToRegExp('*.md').test('a.md'));
  assert.ok(!globToRegExp('*.md').test('docs/a.md'));
  assert.ok(!globToRegExp('a.md').test('axmd'));
});

test('a low-risk change from a trusted author needs no person', () => {
  assert.equal(decide(input()).state, 'success');
});

test('a draft and a commit without classification stay pending', () => {
  assert.equal(decide(input({ pr: pr({ draft: true }) })).state, 'pending');
  assert.match(decide(input({ classification: null })).description, /Waiting/);
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
});

test('an untrusted author on low needs a person and cannot sign off', () => {
  const author = 'mallory';
  assert.equal(decide(input({ pr: pr({ author }) })).state, 'pending');
  const comments = [{ body: `/signoff ${HEAD}`, user: human(author) }];
  assert.deepEqual(findSigners(comments, HEAD, policy()), []);
});

test('the same person approving and signing off counts once', () => {
  const result = decide(input({ classification: { tier: 'high', human: false }, approvers: ['Bob'], signers: ['bob'] }));
  assert.match(result.description, /^high: 1\/2/);
});

test('a fork without classification needs a person', () => {
  const fork = pr({ author: 'alice', headRepo: 'x/r' });
  assert.equal(decide(input({ pr: fork, classification: null })).state, 'pending');
  assert.equal(decide(input({ pr: fork, classification: null, signers: ['alice'] })).state, 'success');
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

test('sign-off requires a trusted person and the exact commit', () => {
  const signers = (comments) => findSigners(comments, HEAD, policy());
  assert.deepEqual(signers([{ body: `/signoff ${HEAD.slice(0, 7)}`, user: human('alice') }]), ['alice']);
  assert.deepEqual(signers([{ body: `/signoff ${OLD.slice(0, 7)}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: '/signoff', user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD.slice(0, 6)}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `please /signoff ${HEAD}`, user: human('alice') }]), []);
  assert.deepEqual(signers([{ body: `/signoff ${HEAD}`, user: { login: 'alice', type: 'Bot' } }]), []);
});

test('an invalid policy is rejected', () => {
  assert.throws(() => validatePolicy({ ...policy(), approvals: { low: 0, medium: '1', high: 2 } }), /medium/);
  assert.throws(() => validatePolicy({ ...policy(), max_rounds: 0 }), /max_rounds/);
  assert.throws(() => validatePolicy({ ...policy(), always_human: undefined }), /required/);
});

test('classification descriptions are parsed strictly', () => {
  assert.deepEqual(parseClassification('tier=high human=1 round=2 capped=0'), { tier: 'high', human: true, round: 2, capped: false });
  assert.equal(parseClassification('tier=none human=1 round=2 capped=0'), null);
  assert.equal(parseClassification('tier=low human=0 round=1 capped=0 extra'), null);
});

test('the shipped policy template is valid', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '../skills/setup/templates/github/review-flow/risk-policy.json');
  assert.ok(validatePolicy(JSON.parse(readFileSync(path, 'utf8'))));
});

function toolkit({ eventName = 'pull_request_target', payload, statusesByRef = {}, commits = [], files = [{ filename: 'a.md' }], reviews = [], comments = [], author = 'alice', env = {} }) {
  const workspace = mkdtempSync(join(tmpdir(), 'review-flow-'));
  mkdirSync(join(workspace, '.github/review-flow'), { recursive: true });
  writeFileSync(join(workspace, '.github/review-flow/risk-policy.json'), JSON.stringify(policy()));
  Object.assign(process.env, { GITHUB_WORKSPACE: workspace, ...env });

  const created = [];
  const posted = [];
  const outputs = {};
  const rest = {
    repos: {
      listCommitStatusesForRef: async ({ ref }) => statusesByRef[ref] ?? [],
      createCommitStatus: async (status) => { created.push(status); },
    },
    pulls: {
      get: async () => ({ data: { draft: false, user: { login: author }, head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } } }),
      listFiles: async () => files,
      listReviews: async () => reviews,
      listCommits: async () => commits,
    },
    issues: {
      listComments: async () => comments,
      createComment: async (comment) => { posted.push(comment); },
    },
  };
  const summary = { addHeading: () => summary, addRaw: () => summary, addList: () => summary, write: async () => {} };
  return {
    created,
    posted,
    outputs,
    github: { rest, paginate: (fn, args) => fn(args) },
    context: { eventName, payload, repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1 },
    core: { info() {}, warning() {}, setOutput: (key, value) => { outputs[key] = value; }, summary },
  };
}

const classified = (description, login = 'github-actions[bot]') => [
  { context: CLASSIFICATION_CONTEXT, description, creator: { login } },
];

test('runGate reads the classification and sets the status on the head commit', async () => {
  const kit = toolkit({
    payload: { pull_request: { number: 7 } },
    statusesByRef: { [HEAD]: classified('tier=low human=0 round=1 capped=0') },
  });
  await runGate(kit);
  assert.equal(kit.created.length, 1);
  assert.equal(kit.created[0].context, GATE_CONTEXT);
  assert.equal(kit.created[0].sha, HEAD);
  assert.equal(kit.created[0].state, 'success');
});

test('runGate ignores a classification status from any other account', async () => {
  const kit = toolkit({
    payload: { pull_request: { number: 7 } },
    statusesByRef: { [HEAD]: classified('tier=low human=0 round=1 capped=0', 'mallory') },
  });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'pending');
});

test('runGate works from a sign-off comment event', async () => {
  const kit = toolkit({
    eventName: 'issue_comment',
    payload: { issue: { number: 7 } },
    statusesByRef: { [HEAD]: classified('tier=medium human=0 round=1 capped=0') },
    comments: [{ body: `/signoff ${HEAD}`, user: human('alice') }],
  });
  await runGate(kit);
  assert.equal(kit.created[0].state, 'success');
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
  assert.deepEqual(first.outputs, { round: '1', since: '', capped: 'false' });

  const next = toolkit({
    payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    commits: [{ sha: OLD }, { sha: HEAD }],
    statusesByRef: { [OLD]: classified('tier=low human=0 round=3 capped=0') },
  });
  await prepareRound(next);
  assert.deepEqual(next.outputs, { round: '4', since: OLD, capped: 'true' });
});

test('a re-run on the same commit does not use up a round', async () => {
  const kit = toolkit({
    payload: { pull_request: { number: 7, head: { sha: HEAD } } },
    commits: [{ sha: HEAD }],
    statusesByRef: { [HEAD]: classified('tier=low human=0 round=1 capped=0') },
  });
  await prepareRound(kit);
  assert.equal(kit.outputs.round, '1');
});

const payload = { pull_request: { number: 7, head: { sha: HEAD } } };

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
  assert.equal(kit.created[0].description, 'tier=low human=0 round=1 capped=0');
  assert.equal(kit.created[1].state, 'success');
  assert.equal(kit.posted.length, 0);
});

test('past the cap a person is required and the author is told once', async () => {
  const atCap = toolkit({ payload, env: { CLASSIFICATION: '{"tier":"low","human_required":false,"reasons":[]}', ROUND: '4', CAPPED: 'true' } });
  await publishClassification(atCap);
  assert.equal(atCap.created[0].description, 'tier=low human=1 round=4 capped=1');
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
