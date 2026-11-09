// Deterministic part of review-flow. The workflows always load this file and
// risk-policy.json from the base commit, so a pull request cannot rewrite the
// rules it is judged by. Uses no packages beyond Node and actions/github-script.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATE_CONTEXT = 'review-flow/gate';
export const CLASSIFICATION_CONTEXT = 'review-flow/classification';

const STATUS_CREATOR = 'github-actions[bot]';
const TIERS = ['low', 'medium', 'high'];
const GITHUB_FILE_LIST_LIMIT = 3000;
const ROUND_LOOKBACK_COMMITS = 50;
const SIGNOFF = /^\/signoff\s+([0-9a-f]{7,40})$/i;
const CLASSIFICATION = /^tier=(low|medium|high) human=([01]) round=(\d+) capped=([01])$/;

const lower = (value) => value.toLowerCase();
const maxTier = (a, b) => TIERS[Math.max(TIERS.indexOf(a), TIERS.indexOf(b))];

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

// An approval only counts for the exact commit it was given on.
export function summarizeReviews(reviews, headSha, author, policy) {
  const humans = latestReviewByUser(reviews).filter((review) => isHuman(review.user, policy));
  return {
    approvers: humans
      .filter((review) => review.state === 'APPROVED' && review.commit_id === headSha && lower(review.user.login) !== lower(author))
      .map((review) => review.user.login),
    changesRequestedBy: humans.filter((review) => review.state === 'CHANGES_REQUESTED').map((review) => review.user.login),
  };
}

// `/signoff <sha>` lets a trusted person, including the author or the person
// who directed an agent, take responsibility for one specific commit.
export function findSigners(comments, headSha, policy) {
  const trusted = policy.trusted_authors.map(lower);
  return comments
    .filter((comment) => {
      const match = comment.body?.trim().match(SIGNOFF);
      return match && headSha.startsWith(lower(match[1])) && isHuman(comment.user, policy) && trusted.includes(lower(comment.user.login));
    })
    .map((comment) => comment.user.login);
}

export function decide({ policy, pr, files, classification, approvers, signers, changesRequestedBy }) {
  const short = pr.headSha.slice(0, 7);
  if (pr.draft) return { state: 'pending', description: 'Draft: not evaluated yet' };

  // Forks get no secrets, so they get no AI review and always need a person.
  const fork = pr.headRepo !== pr.baseRepo;
  if (!classification && !fork) {
    return { state: 'pending', description: `Waiting for AI and security review of ${short}` };
  }
  const result = classification ?? { tier: 'medium', human: true };

  if (changesRequestedBy.length > 0) {
    return { state: 'pending', description: `Changes requested by ${changesRequestedBy.join(', ')}` };
  }

  const rules = pathRules(policy, files);
  const tier = maxTier(result.tier, rules.floor);
  const trusted = policy.trusted_authors.map(lower).includes(lower(pr.author));

  let needed = policy.approvals[tier];
  if (result.human || rules.human || !trusted) needed = Math.max(needed, 1);

  const people = new Set([...approvers, ...signers].map(lower));
  if (people.size >= needed) {
    return { state: 'success', description: `${tier}: ${people.size}/${needed} human approvals on ${short}` };
  }
  return { state: 'pending', description: `${tier}: ${people.size}/${needed} human approvals on ${short}. Approve or /signoff ${short}` };
}

export function parseClassification(description) {
  const match = description?.match(CLASSIFICATION);
  if (!match) return null;
  return { tier: match[1], human: match[2] === '1', round: Number(match[3]), capped: match[4] === '1' };
}

async function readClassification(github, owner, repo, sha) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 });
  const status = statuses.find((item) => item.context === CLASSIFICATION_CONTEXT && item.creator?.login === STATUS_CREATOR);
  return status ? parseClassification(status.description) : null;
}

async function setStatus({ github, context, core }, sha, context_, state, description) {
  const { owner, repo } = context.repo;
  const target_url = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  try {
    await github.rest.repos.createCommitStatus({ owner, repo, sha, state, context: context_, description: description.slice(0, 140), target_url });
  } catch (error) {
    if (error.status !== 403) throw error;
    // Review events from forks get a read-only token.
    core.warning('No permission to set the status from this event. Comment /recheck on the PR.');
  }
}

export async function runGate(toolkit) {
  const { github, context, core } = toolkit;
  if (context.eventName === 'merge_group') {
    // A PR can only enter the queue after this gate has passed.
    await setStatus(toolkit, context.payload.merge_group.head_sha, GATE_CONTEXT, 'success', 'Passed before entering the merge queue');
    return;
  }

  const number = context.payload.pull_request?.number ?? context.payload.issue?.number;
  if (!number) return;

  const { owner, repo } = context.repo;
  const policy = loadPolicy();
  const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const headSha = data.head.sha;
  const pr = {
    headSha,
    draft: data.draft,
    author: data.user.login,
    headRepo: data.head.repo?.full_name ?? '',
    baseRepo: data.base.repo.full_name,
  };

  const [files, reviews, comments, classification] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    readClassification(github, owner, repo, headSha),
  ]);

  const decision = decide({
    policy,
    pr,
    files,
    classification,
    ...summarizeReviews(reviews, headSha, pr.author, policy),
    signers: findSigners(comments, headSha, policy),
  });
  core.info(`${decision.state}: ${decision.description}`);
  await setStatus(toolkit, headSha, GATE_CONTEXT, decision.state, decision.description);
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
}

export async function publishClassification(toolkit) {
  const { github, context, core } = toolkit;
  const { owner, repo } = context.repo;
  const policy = loadPolicy();
  const { number, head } = context.payload.pull_request;
  const round = Number(process.env.ROUND);
  const capped = process.env.CAPPED === 'true';

  const result = JSON.parse(process.env.CLASSIFICATION);
  if (!TIERS.includes(result.tier) || typeof result.human_required !== 'boolean' || !Number.isInteger(round) || round < 1) {
    throw new Error('Invalid classification output');
  }

  // Past the round cap, the bug review no longer runs, so a person has to look.
  const human = result.human_required || capped;
  const description = `tier=${result.tier} human=${human ? 1 : 0} round=${round} capped=${capped ? 1 : 0}`;
  await setStatus(toolkit, head.sha, CLASSIFICATION_CONTEXT, 'success', description);

  await core.summary
    .addHeading('Risk classification')
    .addRaw(description)
    .addList((result.reasons ?? []).map(String))
    .write();

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
