#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO = 'PostHog/posthog';
const DAYS = 90;
const CONCURRENCY = 8;
const ISSUE_LABELS = ['bug', 'enhancement'];

// Checkpoint directory — each fetched PR writes its own file here.
// On restart, already-done PRs are skipped automatically.
const CHECKPOINT_DIR = join(__dirname, '.fetch-checkpoint');
mkdirSync(CHECKPOINT_DIR, { recursive: true });

const since = new Date();
since.setDate(since.getDate() - DAYS);
const sinceISO = since.toISOString();

// ── Token pool ─────────────────────────────────────────────────────────────
// Each token has its own 5000/hr rate limit. Round-robin across all provided
// tokens; block a token when it hits its limit and route to the others.
const TOKEN_POOL = [
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_TOKEN_2,
  process.env.GITHUB_TOKEN_3,
  process.env.GITHUB_TOKEN_4,
  process.env.GITHUB_TOKEN_5,
].filter(Boolean).map(token => ({ token, blockedUntil: 0 }));

if (!TOKEN_POOL.length) {
  console.error('ERROR: Set at least GITHUB_TOKEN env var.');
  process.exit(1);
}

let rrIdx = 0;

async function acquireToken() {
  while (true) {
    const now = Date.now();
    for (let i = 0; i < TOKEN_POOL.length; i++) {
      const idx = (rrIdx + i) % TOKEN_POOL.length;
      if (TOKEN_POOL[idx].blockedUntil <= now) {
        rrIdx = (idx + 1) % TOKEN_POOL.length;
        return TOKEN_POOL[idx];
      }
    }
    const earliest = Math.min(...TOKEN_POOL.map(t => t.blockedUntil));
    await sleep(Math.max(earliest - Date.now(), 100));
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, attempt = 0) {
  const tokenState = await acquireToken();
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'posthog-impact-dashboard',
    Authorization: `Bearer ${tokenState.token}`,
  };
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    if (attempt < 4) { await sleep(1000 * (attempt + 1)); return fetchJSON(url, attempt + 1); }
    throw e;
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0');
    tokenState.blockedUntil = Math.max((reset * 1000) + 1000, Date.now() + 5000);
    console.warn(`\n  Token blocked until ${new Date(tokenState.blockedUntil).toLocaleTimeString()} — routing to others.`);
    return fetchJSON(url, attempt + 1);
  }
  if (!res.ok) {
    if (attempt < 3) { await sleep(1000 * (attempt + 1)); return fetchJSON(url, attempt + 1); }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function batchProcess(items, fn, label = 'items', concurrency = CONCURRENCY) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) results.push(r.status === 'fulfilled' ? r.value : null);
    if (i % (concurrency * 10) === 0) process.stdout.write(`\r  ${Math.min(i + concurrency, items.length)}/${items.length} ${label}...`);
    await sleep(40);
  }
  process.stdout.write(`\r  ${items.length}/${items.length} ${label}.   \n`);
  return results;
}

// ── PR list + unmerged tracking ─────────────────────────────────────────────
async function fetchAllPRs() {
  const mergedPRs = [];
  const closedUnmergedPerAuthor = {};
  let page = 1;

  while (true) {
    process.stdout.write(`\r  Fetching PR list page ${page}...`);
    const data = await fetchJSON(
      `https://api.github.com/repos/${REPO}/pulls?state=closed&per_page=100&page=${page}&sort=created&direction=desc`
    );
    if (!data.length) break;

    let hitCutoff = false;
    for (const pr of data) {
      const login = pr.user?.login;
      if (!pr.merged_at) {
        if (login && login !== 'ghost' && pr.created_at >= sinceISO) {
          closedUnmergedPerAuthor[login] = (closedUnmergedPerAuthor[login] || 0) + 1;
        }
        continue;
      }
      if (pr.merged_at < sinceISO) { hitCutoff = true; break; }
      mergedPRs.push(pr);
    }
    if (hitCutoff || data[data.length - 1].created_at < sinceISO) break;
    page++;
    await sleep(60);
  }

  const unmergedTotal = Object.values(closedUnmergedPerAuthor).reduce((a, b) => a + b, 0);
  console.log(`\r  Found ${mergedPRs.length} merged + ${unmergedTotal} closed-unmerged PRs in last ${DAYS} days.`);
  return { mergedPRs, closedUnmergedPerAuthor };
}

// ── PR detail: files + reviews + timeline (for accurate review assignment time) ─
// Checkpoint: if this PR was already fetched in a prior run, return cached result immediately.
async function fetchPRDetails(pr) {
  const cpFile = join(CHECKPOINT_DIR, `${pr.number}.json`);
  if (existsSync(cpFile)) {
    try { return JSON.parse(readFileSync(cpFile, 'utf8')); } catch { /* corrupt — re-fetch */ }
  }

  try {
    const [files, reviews, timeline] = await Promise.all([
      fetchJSON(`https://api.github.com/repos/${REPO}/pulls/${pr.number}/files?per_page=100`),
      fetchJSON(`https://api.github.com/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`),
      fetchJSON(`https://api.github.com/repos/${REPO}/issues/${pr.number}/timeline?per_page=100`),
    ]);

    // Map reviewer → time they were formally requested (from timeline events).
    // Falls back to PR creation time if no formal request event found.
    const reviewerRequestedAt = {};
    for (const event of (timeline || [])) {
      if (event.event === 'review_requested' && event.requested_reviewer?.login) {
        reviewerRequestedAt[event.requested_reviewer.login] = event.created_at;
      }
    }

    const result = {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login,
      merged_at: pr.merged_at,
      created_at: pr.created_at,
      files: files.map(f => f.filename),
      reviews: reviews
        .filter(r => r.user?.login && r.user.login !== pr.user?.login)
        .map(r => ({
          reviewer: r.user.login,
          submitted_at: r.submitted_at,
          state: r.state,
          requested_at: reviewerRequestedAt[r.user.login] || pr.created_at,
        })),
    };

    writeFileSync(cpFile, JSON.stringify(result));
    return result;
  } catch (e) {
    console.warn(`\nFailed PR #${pr.number}: ${e.message}`);
    return null;
  }
}

// ── Issue engagement ────────────────────────────────────────────────────────

// Parse "Closes #N", "Fixes #N", "Resolves #N" from PR bodies (already in list data).
function buildIssueClosingMap(mergedPRs) {
  const map = {}; // issueNumber → authorLogin of closing PR
  const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  for (const pr of mergedPRs) {
    if (!pr.body || !pr.user?.login || pr.user.login === 'ghost') continue;
    let m;
    while ((m = pattern.exec(pr.body)) !== null) {
      const issueNum = parseInt(m[1]);
      if (!map[issueNum]) map[issueNum] = pr.user.login;
    }
  }
  return map;
}

async function fetchIssueData(mergedPRs) {
  const issueClosingAuthor = buildIssueClosingMap(mergedPRs);

  // Collect bug + enhancement issues closed within the 90-day window.
  // GitHub's `since` param filters by updated_at, so we post-filter on closed_at.
  const seen = new Set();
  const qualifyingIssues = [];

  for (const label of ISSUE_LABELS) {
    let page = 1;
    while (true) {
      process.stdout.write(`\r  Fetching ${label} issues page ${page}...`);
      const data = await fetchJSON(
        `https://api.github.com/repos/${REPO}/issues?state=closed&labels=${encodeURIComponent(label)}&since=${sinceISO}&per_page=100&page=${page}`
      );
      if (!data.length) break;
      for (const issue of data) {
        if (issue.pull_request) continue; // GitHub returns PRs via this endpoint — skip
        if (seen.has(issue.number)) continue;
        if (issue.closed_at && issue.closed_at >= sinceISO) {
          seen.add(issue.number);
          qualifyingIssues.push(issue);
        }
      }
      if (data.length < 100) break;
      page++;
      await sleep(60);
    }
  }
  console.log(`\r  Found ${qualifyingIssues.length} qualifying bug/enhancement issues.   `);

  // Fetch comments per issue to identify who engaged
  const commentResults = await batchProcess(
    qualifyingIssues,
    async (issue) => {
      const comments = await fetchJSON(
        `https://api.github.com/repos/${REPO}/issues/${issue.number}/comments?per_page=100`
      );
      return { issueNumber: issue.number, comments };
    },
    'issues commented'
  );

  const issuesResolvedPerAuthor = {};
  const issuesEngagedPerAuthor = {};

  for (const result of commentResults) {
    if (!result) continue;
    const { issueNumber, comments } = result;
    const closingAuthor = issueClosingAuthor[issueNumber];

    // Resolution credit: authored the PR that closed this issue
    if (closingAuthor && closingAuthor !== 'ghost') {
      issuesResolvedPerAuthor[closingAuthor] = (issuesResolvedPerAuthor[closingAuthor] || 0) + 1;
    }

    // Engagement credit: commented on the issue but didn't author the closing PR
    const commenters = new Set(
      comments.map(c => c.user?.login).filter(l => l && l !== 'ghost' && l !== closingAuthor)
    );
    for (const login of commenters) {
      issuesEngagedPerAuthor[login] = (issuesEngagedPerAuthor[login] || 0) + 1;
    }
  }

  console.log(`  Resolved: ${Object.values(issuesResolvedPerAuthor).reduce((a, b) => a + b, 0)} issues by ${Object.keys(issuesResolvedPerAuthor).length} engineers`);
  console.log(`  Engaged:  ${Object.values(issuesEngagedPerAuthor).reduce((a, b) => a + b, 0)} issues by ${Object.keys(issuesEngagedPerAuthor).length} engineers`);

  return { issues_resolved_per_author: issuesResolvedPerAuthor, issues_engaged_per_author: issuesEngagedPerAuthor };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Count already-saved checkpoints so the user knows how much will be skipped
  const existingCheckpoints = readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json')).length;
  if (existingCheckpoints > 0) {
    console.log(`\nResuming — ${existingCheckpoints} PRs already fetched from prior run (will be skipped).`);
  }

  console.log(`\nFetching PostHog data (last ${DAYS} days) with ${TOKEN_POOL.length} token(s)...\n`);

  const { mergedPRs, closedUnmergedPerAuthor } = await fetchAllPRs();

  const allPRsMeta = mergedPRs.map(pr => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    merged_at: pr.merged_at,
    created_at: pr.created_at,
    review_comments: pr.review_comments || 0,
    changed_files: pr.changed_files || 0,
  }));

  // Fetch full detail for all merged PRs (files + reviews + timeline).
  // Already-checkpointed PRs are returned instantly from disk.
  console.log(`\nFetching files + reviews + timeline for all ${mergedPRs.length} PRs...`);
  const details = await batchProcess(mergedPRs, fetchPRDetails, 'PRs detailed');
  const prs = details.filter(Boolean);

  console.log(`\nFetching issue engagement data...`);
  const { issues_resolved_per_author, issues_engaged_per_author } = await fetchIssueData(mergedPRs);

  mkdirSync(join(__dirname, 'public'), { recursive: true });
  const outPath = join(__dirname, 'public', 'data.json');
  writeFileSync(outPath, JSON.stringify({
    fetched_at: new Date().toISOString(),
    since: sinceISO,
    all_prs_meta: allPRsMeta,
    prs,
    closed_unmerged_per_author: closedUnmergedPerAuthor,
    issues_resolved_per_author,
    issues_engaged_per_author,
  }, null, 2));

  const uniqueAuthors = new Set(allPRsMeta.map(p => p.author)).size;
  console.log(`\nDone!`);
  console.log(`  Full 90-day dataset : ${allPRsMeta.length} merged PRs from ${uniqueAuthors} contributors`);
  console.log(`  Detailed PRs        : ${prs.length} (files + reviews + timeline)`);
  console.log(`  Output              : ${outPath}`);
  console.log(`  Checkpoints saved   : ${CHECKPOINT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
