// Deterministic part of review-flow. The workflows always load this file and
// risk-policy.json from the base or default branch, so a pull request cannot
// rewrite the rules it is judged by. Uses nothing beyond Node and
// actions/github-script.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATE_CONTEXT = 'review-flow/gate';
export const CLASSIFICATION_CONTEXT = 'review-flow/classification';
export const FINDING_MARKER = '<!-- review-flow:finding -->';

const STATUS_CREATOR = 'github-actions[bot]';
const TIERS = ['low', 'medium', 'high'];
const WRITE_PERMISSIONS = ['admin', 'maintain', 'write'];
const GITHUB_FILE_LIST_LIMIT = 3000;
const ROUND_LOOKBACK_COMMITS = 50;
const SIGNOFF = /^\/signoff\s+([0-9a-f]{40})$/i;
const CLASSIFICATION = /^tier=(low|medium|high) human=([01]) round=(\d+) capped=([01]) base=([0-9a-f]{8})$/;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 1) { nodes { body author { login __typename } } }
        }
      }
    }
  }
}`;
const RESOLVE_THREAD = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

const lower = (value) => value.toLowerCase();
const maxTier = (a, b) => TIERS[Math.max(TIERS.indexOf(a), TIERS.indexOf(b))];

// A classification is valid only for the base branch it was made against.
export const baseKey = (ref) => createHash('sha256').update(ref).digest('hex').slice(0, 8);

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function validatePolicy(policy) {
  for (const tier of TIERS) {
    if (!Number.isInteger(policy.approvals?.[tier]) || policy.approvals[tier] < 0) {
      throw new Error(`risk-policy: approvals.${tier} must be a non-negative integer`);
    }
  }
  if (!Number.isInteger(policy.max_rounds) || policy.max_rounds < 1) {
    throw new Error('risk-policy: max_rounds must be a positive integer');
  }
  const lists = [policy.trusted_authors, policy.agent_accounts, policy.always_human];
  if (!lists.every(Array.isArray) || typeof policy.floors !== 'object' || policy.floors === null) {
    throw new Error('risk-policy: trusted_authors, agent_accounts, always_human and floors are required');
  }
  return policy;
}

function loadPolicy() {
  const path = join(process.env.GITHUB_WORKSPACE, '.github/review-flow/risk-policy.json');
  return validatePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

// A rename counts as touching both paths, so moving a file out of a sensitive
// directory does not escape the rules for that directory.
export function pathRules(policy, files) {
  const paths = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  const matchesAny = (patterns = []) => {
    const regexes = patterns.map(globToRegExp);
    return paths.some((path) => regexes.some((regex) => regex.test(path)));
  };
  let floor = 'low';
  if (matchesAny(policy.floors.medium)) floor = 'medium';
  if (matchesAny(policy.floors.high) || files.length >= GITHUB_FILE_LIST_LIMIT) floor = 'high';
  return { floor, human: matchesAny(policy.always_human) };
}

function isHuman(user, policy) {
  if (!user || user.type !== 'User' || user.login.endsWith('[bot]')) return false;
  return !policy.agent_accounts.map(lower).includes(lower(user.login));
}

function latestReviewByUser(reviews) {
  const latest = new Map();
  const decisive = reviews
    .filter((review) => review.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  for (const review of decisive) latest.set(lower(review.user.login), review);
  return [...latest.values()];
}

// An approval only counts for the exact commit it was given on. Write access
// is checked separately by keepWriters.
export function summarizeReviews(reviews, headSha, author, policy) {
  const humans = latestReviewByUser(reviews).filter((review) => isHuman(review.user, policy));
  return {
    approvers: humans
      .filter((review) => review.state === 'APPROVED' && review.commit_id === headSha && lower(review.user.login) !== lower(author))
      .map((review) => review.user.login),
    changesRequestedBy: humans.filter((review) => review.state === 'CHANGES_REQUESTED').map((review) => review.user.login),
  };
}

// Anyone can submit a review on a public repository, so only people with write
// access count. If the check fails, the person does not count.
export async function keepWriters(github, owner, repo, logins) {
  const writers = [];
  for (const username of logins) {
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      if ([data.permission, data.role_name].some((permission) => WRITE_PERMISSIONS.includes(permission))) {
        writers.push(username);
      }
    } catch {
      // Not a collaborator, or the check is unavailable.
    }
  }
  return writers;
}

// `/signoff <full sha>` lets a trusted person, including the author or the
// person who directed an agent, take responsibility for one specific commit.
// A short prefix is not accepted, because a matching commit can be forged.
export function findSigners(comments, headSha, policy) {
  const trusted = policy.trusted_authors.map(lower);
  return comments
    .filter((comment) => {
      const match = comment.body?.trim().match(SIGNOFF);
      return match && lower(match[1]) === lower(headSha) && isHuman(comment.user, policy) && trusted.includes(lower(comment.user.login));
    })
    .map((comment) => comment.user.login);
}

export function decide({ policy, pr, files, classification, approvers, signers, changesRequestedBy }) {
  if (pr.draft) return { state: 'pending', description: 'Draft: not evaluated yet' };
  if (changesRequestedBy.length > 0) {
    return { state: 'pending', description: `Changes requested by ${changesRequestedBy.join(', ')}` };
  }

  // No classification means no AI review for this commit and base: a fork,
  // a failed or unfinished run, or a changed base branch. A person decides.
  const result = classification ?? { tier: 'medium', human: true };
  const note = classification ? '' : ' (no AI review)';

  const rules = pathRules(policy, files);
  const tier = maxTier(result.tier, rules.floor);
  const trusted = policy.trusted_authors.map(lower).includes(lower(pr.author));

  let needed = policy.approvals[tier];
  if (result.human || rules.human || !trusted) needed = Math.max(needed, 1);

  const people = new Set([...approvers, ...signers].map(lower));
  const count = `${tier}: ${people.size}/${needed} human approvals${note}`;
  if (people.size >= needed) return { state: 'success', description: count };
  return { state: 'pending', description: `${count}. Approve, or /signoff ${pr.headSha}` };
}

export function parseClassification(description) {
  const match = description?.match(CLASSIFICATION);
  if (!match) return null;
  return { tier: match[1], human: match[2] === '1', round: Number(match[3]), capped: match[4] === '1', base: match[5] };
}

async function readClassification(github, owner, repo, sha) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 });
  const status = statuses.find((item) => item.context === CLASSIFICATION_CONTEXT && item.creator?.login === STATUS_CREATOR);
  return status ? parseClassification(status.description) : null;
}

async function setStatus({ github, context }, sha, statusContext, state, description) {
  const { owner, repo } = context.repo;
  const target_url = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  await github.rest.repos.createCommitStatus({ owner, repo, sha, state, context: statusContext, description: description.slice(0, 140), target_url });
}

async function evaluatePullRequest(toolkit, policy, number) {
  const { github, context, core } = toolkit;
  const { owner, repo } = context.repo;
  const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const headSha = data.head.sha;
  const pr = { headSha, draft: data.draft, author: data.user.login };

  const [files, reviews, comments, stored] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    readClassification(github, owner, repo, headSha),
  ]);
  const classification = stored?.base === baseKey(data.base.ref) ? stored : null;
  const { approvers, changesRequestedBy } = summarizeReviews(reviews, headSha, pr.author, policy);

  const decision = decide({
    policy,
    pr,
    files,
    classification,
    approvers: await keepWriters(github, owner, repo, approvers),
    changesRequestedBy: await keepWriters(github, owner, repo, changesRequestedBy),
    signers: findSigners(comments, headSha, policy),
  });
  core.info(`#${number} ${decision.state}: ${decision.description}`);
  await setStatus(toolkit, headSha, GATE_CONTEXT, decision.state, decision.description);
}

// Review events reach the gate through workflow_run, which runs from the
// default branch with a token that can set statuses, including for forks.
async function pullRequestsForRun(github, owner, repo, run) {
  const linked = (run.pull_requests ?? []).map((pr) => pr.number);
  if (linked.length > 0) return linked;
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  return open.filter((pr) => pr.head.sha === run.head_sha).map((pr) => pr.number);
}

export async function runGate(toolkit) {
  const { github, context } = toolkit;
  if (context.eventName === 'merge_group') {
    // A PR can only enter the queue after this gate has passed.
    await setStatus(toolkit, context.payload.merge_group.head_sha, GATE_CONTEXT, 'success', 'Passed before entering the merge queue');
    return;
  }

  const { owner, repo } = context.repo;
  const numbers = context.eventName === 'workflow_run'
    ? await pullRequestsForRun(github, owner, repo, context.payload.workflow_run)
    : [context.payload.pull_request?.number ?? context.payload.issue?.number].filter(Boolean);
  if (numbers.length === 0) return;

  const policy = loadPolicy();
  for (const number of numbers) await evaluatePullRequest(toolkit, policy, number);
}

// Earlier findings posted by the reviewer, open and resolved, so a later round
// neither repeats them nor re-raises one a person closed.
export async function listFindingThreads(github, owner, repo, number) {
  const threads = [];
  let cursor = null;
  do {
    const data = await github.graphql(THREADS_QUERY, { owner, repo, number, cursor });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const first = node.comments.nodes[0];
      if (first?.author?.__typename === 'Bot' && first.body.includes(FINDING_MARKER)) {
        threads.push({ id: node.id, resolved: node.isResolved, outdated: node.isOutdated, path: node.path, line: node.line, body: first.body.slice(0, 2000) });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

export async function prepareRound({ github, context, core }) {
  const { owner, repo } = context.repo;
  const policy = loadPolicy();
  const { number, head } = context.payload.pull_request;
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: number, per_page: 100 });

  const earlier = commits.map((commit) => commit.sha).filter((sha) => sha !== head.sha).reverse().slice(0, ROUND_LOOKBACK_COMMITS);
  let previous = null;
  for (const sha of earlier) {
    const classification = await readClassification(github, owner, repo, sha);
    if (classification) {
      previous = { sha, round: classification.round };
      break;
    }
  }

  const round = previous ? previous.round + 1 : 1;
  core.setOutput('round', String(round));
  core.setOutput('since', previous?.sha ?? '');
  core.setOutput('capped', String(round > policy.max_rounds));
  core.setOutput('threads', JSON.stringify(await listFindingThreads(github, owner, repo, number)));
}

export function parseFixedThreads(output) {
  if (!output) return [];
  try {
    const ids = JSON.parse(output).fixed_threads;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// The model only reports which findings it thinks are fixed. A thread is
// resolved only if it is the reviewer's own, still open, and GitHub marks it
// outdated because the code under it changed.
export function threadsToResolve(threads, ids) {
  const wanted = new Set(ids);
  return threads.filter((thread) => wanted.has(thread.id) && !thread.resolved && thread.outdated);
}

export async function publishClassification(toolkit) {
  const { github, context, core } = toolkit;
  const { owner, repo } = context.repo;
  const policy = loadPolicy();
  const { number, head, base } = context.payload.pull_request;
  const round = Number(process.env.ROUND);
  const capped = process.env.CAPPED === 'true';

  const result = JSON.parse(process.env.CLASSIFICATION);
  if (!TIERS.includes(result.tier) || typeof result.human_required !== 'boolean' || !Number.isInteger(round) || round < 1) {
    throw new Error('Invalid classification output');
  }

  // Past the round cap, the bug review no longer runs, so a person has to look.
  const human = result.human_required || capped;
  const description = `tier=${result.tier} human=${human ? 1 : 0} round=${round} capped=${capped ? 1 : 0} base=${baseKey(base.ref)}`;
  await setStatus(toolkit, head.sha, CLASSIFICATION_CONTEXT, 'success', description);

  await core.summary
    .addHeading('Risk classification')
    .addRaw(description)
    .addList((result.reasons ?? []).map(String))
    .write();

  const fixed = [...parseFixedThreads(process.env.FIXED_REVIEW), ...parseFixedThreads(process.env.FIXED_SECURITY)];
  if (fixed.length > 0) {
    const threads = await listFindingThreads(github, owner, repo, number);
    for (const thread of threadsToResolve(threads, fixed)) {
      await github.graphql(RESOLVE_THREAD, { id: thread.id });
      core.info(`Resolved fixed finding at ${thread.path}:${thread.line}`);
    }
  }

  if (capped && round === policy.max_rounds + 1) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: `This PR has been through ${policy.max_rounds} review rounds, so automated bug review has stopped. Consider stepping back to rethink the approach. Security review keeps running, and a person now has to approve each new commit.`,
    });
  }

  await runGate(toolkit);
}
