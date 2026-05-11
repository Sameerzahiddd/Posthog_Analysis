function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function generateInsights(e, allEngineers, maxWeeks) {
  const total = allEngineers.length;
  const reviewRank  = allEngineers.filter(x => x._reviewsGiven > e._reviewsGiven).length + 1;
  const breadthRank = allEngineers.filter(x => x._dirsCount > e._dirsCount).length + 1;

  // Review Activity
  let multiplier;
  if (e._reviewsGiven === 0) {
    multiplier = `${e.login} left no reviews in the sampled window → review activity score: 0/100. Impact comes primarily through authoring (${e._prsAuthored} PRs merged).`;
  } else {
    const speedNote = e._avgReviewHours < 999 ? `${e._avgReviewHours}h avg turnaround from assignment` : 'turnaround N/A';
    const dataLine = [
      `${e._reviewsGiven} reviews given (${ordinal(reviewRank)} of ${total})`,
      `weighted by review type (CHANGES_REQUESTED 1.5×, APPROVED 1.0×, COMMENTED 0.8×)`,
      speedNote,
    ].filter(Boolean).join(' · ');
    multiplier = `Data: ${dataLine} → applied to formula → ${e.dimensions.multiplier}/100`;
  }

  // Critical Path
  const critContext = e.dimensions.critical >= 75
    ? 'works on heavily shared core code'
    : e.dimensions.critical >= 40
    ? 'touches a mix of shared and specialized code'
    : 'focused on specialized/isolated code';
  const critical = `${e.login} ${critContext}. avg file criticality (log-weighted by PR traffic) across their ${e._prsInSample} sampled PRs → ${e.dimensions.critical}/100`;

  // Consistency
  const consistencyContext = e._weeksActive === maxWeeks
    ? 'contributed every week in the window'
    : e._weeksActive >= maxWeeks * 0.8
    ? 'highly consistent contributor'
    : e._weeksActive >= maxWeeks * 0.5
    ? 'active most weeks'
    : 'concentrated activity in fewer weeks';
  const consistency = `${e.login} merged PRs in ${e._weeksActive} of ${maxWeeks} possible weeks (${consistencyContext}) → ${e.dimensions.consistency}/100`;

  // Breadth
  const breadthContext = breadthRank <= 5
    ? `${ordinal(breadthRank)} of ${total} contributors by cross-domain reach`
    : e._dirsCount >= 8
    ? 'broad generalist footprint'
    : 'focused specialist';
  const breadth = `${e.login} contributed to ${e._dirsCount} distinct top-level director${e._dirsCount !== 1 ? 'ies' : 'y'} across ${e._prsInSample} sampled PRs (${breadthContext}) → score = ${e._dirsCount} × ${e._prsInSample}^0.15 → normalized to ${e.dimensions.breadth}/100`;

  // Acceptance Rate
  let acceptance;
  if (e._totalPRsOpened === 0 || e._totalPRsOpened === e._prsAuthored) {
    acceptance = `${e.login}: ${e._prsAuthored} merged ÷ ${e._prsAuthored} opened = 100% acceptance → ${e.dimensions.acceptance}/100`;
  } else {
    const unmerged = e._totalPRsOpened - e._prsAuthored;
    acceptance = `${e.login}: ${e._prsAuthored} merged ÷ ${e._totalPRsOpened} opened = ${e._acceptanceRate}% acceptance rate (${unmerged} closed without merging) → normalized to ${e.dimensions.acceptance}/100`;
  }

  // Issue Resolution
  let issue;
  if (e._issuesResolved === 0 && e._issuesEngaged === 0) {
    issue = `${e.login} had no recorded activity on bug/enhancement issues in this window → issue score: 0/100.`;
  } else {
    const parts = [];
    if (e._issuesResolved > 0) parts.push(`${e._issuesResolved} issue${e._issuesResolved !== 1 ? 's' : ''} resolved (authored closing PR)`);
    if (e._issuesEngaged > 0) parts.push(`${e._issuesEngaged} issue${e._issuesEngaged !== 1 ? 's' : ''} engaged (commented, not the fixer)`);
    issue = `${e.login}: ${parts.join(' · ')} → score = (${e._issuesResolved}×2 + ${e._issuesEngaged}×0.5) normalized → ${e.dimensions.issue}/100`;
  }

  // Revert note (shown in methodology footer, not a dimension)
  const revertNote = e.reverts_received === 0
    ? `${e.login} had 0 PRs reverted in the 90-day window → no penalty applied.`
    : `${e.login}: ${e.reverts_received} PR${e.reverts_received !== 1 ? 's' : ''} reverted out of ${e._prsAuthored} merged (${e.revertRate}%) → composite score reduced by ${Math.min(25, e.revertRate)}%.`;

  return { multiplier, critical, consistency, breadth, acceptance, issue, revertNote };
}

export function computeImpact(data) {
  const {
    prs,
    all_prs_meta,
    closed_unmerged_per_author = {},
    issues_resolved_per_author = {},
    issues_engaged_per_author = {},
  } = data;

  // Revert detection from full 90-day dataset.
  // Covers all common formats GitHub generates or engineers write:
  //   Revert "Some PR title (#1234)"   ← GitHub auto-generated
  //   Revert #1234 / Reverts #1234     ← direct reference
  //   Revert some description (#1234)  ← PR number in parens
  //   revert: description (#1234)      ← conventional commit style
  //   Revert PR #1234                  ← explicit PR prefix
  const revertTargets = new Set();
  function extractRevertTarget(title) {
    if (!title) return null;
    let m = title.match(/[Rr]evert[^(]*\(#(\d+)\)/);
    if (m) return parseInt(m[1]);
    m = title.match(/[Rr]everts?\s+(?:PR\s+)?["']?#(\d+)/);
    if (m) return parseInt(m[1]);
    m = title.match(/[Rr]evert.*#(\d+)/);
    if (m) return parseInt(m[1]);
    return null;
  }
  for (const pr of all_prs_meta) {
    const target = extractRevertTarget(pr.title);
    if (target) revertTargets.add(target);
  }

  // File criticality: count how many PRs touched each file
  const filePRCount = {};
  for (const pr of prs) {
    for (const f of pr.files) {
      filePRCount[f] = (filePRCount[f] || 0) + 1;
    }
  }

  // Consistency: bucket each PR into a calendar-week slot per author
  const weeksByAuthor = {};
  for (const pr of all_prs_meta) {
    if (!pr.author || pr.author === 'ghost' || pr.author.includes('[bot]')) continue;
    const weekSlot = Math.floor(new Date(pr.merged_at).getTime() / (7 * 24 * 3600 * 1000));
    if (!weeksByAuthor[pr.author]) weeksByAuthor[pr.author] = new Set();
    weeksByAuthor[pr.author].add(weekSlot);
  }
  const allWeekSets = Object.values(weeksByAuthor);
  const maxWeeks = allWeekSets.length > 0
    ? Math.max(...allWeekSets.map(s => s.size))
    : 1;

  const engineers = {};
  function eng(login) {
    if (!engineers[login]) {
      engineers[login] = {
        login,
        authored_prs: [],
        all_authored_count: 0,
        reverts_received: 0,
        reviews_given: [],
        dirs_touched: new Set(),
        critical_path_sum: 0,
      };
    }
    return engineers[login];
  }

  for (const pr of all_prs_meta) {
    if (!pr.author || pr.author === 'ghost') continue;
    eng(pr.author).all_authored_count += 1;
    if (revertTargets.has(pr.number)) eng(pr.author).reverts_received += 1;
  }

  // Review state weights: CHANGES_REQUESTED shows real scrutiny, COMMENTED shows
  // engagement without verdict, DISMISSED means the review was abandoned.
  const STATE_WEIGHT = { APPROVED: 1.0, COMMENTED: 0.8, CHANGES_REQUESTED: 1.5, DISMISSED: 0.3 };

  for (const pr of prs) {
    if (!pr.author || pr.author === 'ghost') continue;
    const author = eng(pr.author);
    author.authored_prs.push(pr.number);
    for (const f of pr.files) {
      author.critical_path_sum += Math.log1p(filePRCount[f] || 1);
      author.dirs_touched.add(f.split('/')[0]);
    }
    for (const review of pr.reviews) {
      if (!review.reviewer || review.reviewer === 'ghost') continue;
      eng(review.reviewer).reviews_given.push({
        submitted_at: review.submitted_at,
        requested_at: review.requested_at || pr.created_at,
        state: review.state,
      });
    }
  }

  const scored = Object.values(engineers)
    .filter(e => e.all_authored_count >= 3 && !e.login.includes('[bot]'))
    .map(e => {
      const allPRs = e.all_authored_count;
      const prsInSample = e.authored_prs.length;

      // Review Activity: weighted review count × speed factor.
      // State weights: CHANGES_REQUESTED 1.5×, APPROVED 1.0×, COMMENTED 0.8×, DISMISSED 0.3×
      // Speed factor range: 0.5 (very slow) → ~1.5 (reviewed within 1h of assignment)
      const reviewCount = e.reviews_given.length;
      const weightedReviews = e.reviews_given.reduce(
        (sum, r) => sum + (STATE_WEIGHT[r.state] ?? 1.0), 0
      );
      const speeds = e.reviews_given.map(r =>
        Math.max(0, (new Date(r.submitted_at) - new Date(r.requested_at)) / 3600000));
      const avgHrs = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 999;
      const speedScore = Math.max(0, 100 - Math.log1p(avgHrs) * 15);
      const multiplierRaw = weightedReviews * (speedScore / 100 + 0.5);

      // Critical path: avg log-weighted file traffic across this engineer's PRs
      const criticalRaw = prsInSample > 0 ? e.critical_path_sum / prsInSample : 0;

      // Consistency: distinct calendar weeks with ≥1 merged PR
      const weeksActive = weeksByAuthor[e.login]?.size ?? 0;
      const consistencyRaw = maxWeeks > 0 ? weeksActive / maxWeeks : 0;

      // Breadth: dirs touched with a slight volume bonus via prsInSample^0.15
      const breadthRaw = e.dirs_touched.size * Math.pow(prsInSample || 1, 0.15);

      // Acceptance rate
      const unmerged = closed_unmerged_per_author[e.login] || 0;
      const totalOpened = allPRs + unmerged;
      const acceptanceRaw = totalOpened > 0 ? allPRs / totalOpened : 1;
      const acceptanceRate = Math.round(acceptanceRaw * 100);

      // Issue resolution
      const issuesResolved = issues_resolved_per_author[e.login] || 0;
      const issuesEngaged  = issues_engaged_per_author[e.login]  || 0;
      const issueRaw = issuesResolved * 2 + issuesEngaged * 0.5;

      // Revert penalty computed here while we have access to raw engineer fields
      const revertRate = e.reverts_received / Math.max(1, allPRs);
      const revertPenalty = Math.min(0.25, revertRate);

      return {
        login: e.login,
        prsAuthored: allPRs,
        reviewsGiven: reviewCount,
        dirsCount: e.dirs_touched.size,
        avgReviewHours: Math.round(avgHrs),
        totalPRsOpened: totalOpened,
        acceptanceRate,
        issuesResolved,
        issuesEngaged,
        reverts_received: e.reverts_received,
        revertRate: Math.round(revertRate * 100),
        revertPenalty,
        // private fields for insights
        _reviewsGiven: reviewCount,
        _weeksActive: weeksActive,
        _dirsCount: e.dirs_touched.size,
        _avgReviewHours: Math.round(avgHrs),
        _prsAuthored: allPRs,
        _prsInSample: prsInSample,
        _totalPRsOpened: totalOpened,
        _acceptanceRate: acceptanceRate,
        _issuesResolved: issuesResolved,
        _issuesEngaged: issuesEngaged,
        raw: { multiplierRaw, criticalRaw, consistencyRaw, breadthRaw, acceptanceRaw, issueRaw },
      };
    });

  function normalize(vals) {
    const min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) return vals.map(() => 50);
    return vals.map(v => ((v - min) / (max - min)) * 100);
  }

  const multiplierNorm   = normalize(scored.map(e => e.raw.multiplierRaw));
  const criticalNorm     = normalize(scored.map(e => e.raw.criticalRaw));
  const consistencyNorm  = normalize(scored.map(e => e.raw.consistencyRaw));
  const breadthNorm      = normalize(scored.map(e => e.raw.breadthRaw));
  const acceptanceNorm   = normalize(scored.map(e => e.raw.acceptanceRaw));
  const issueNorm        = normalize(scored.map(e => e.raw.issueRaw));

  const WEIGHTS = { multiplier: 0.20, critical: 0.20, consistency: 0.20, breadth: 0.15, acceptance: 0.15, issue: 0.10 };

  const allScored = scored.map((e, i) => {
    const baseScore =
      multiplierNorm[i]  * WEIGHTS.multiplier  +
      criticalNorm[i]    * WEIGHTS.critical    +
      consistencyNorm[i] * WEIGHTS.consistency +
      breadthNorm[i]     * WEIGHTS.breadth     +
      acceptanceNorm[i]  * WEIGHTS.acceptance  +
      issueNorm[i]       * WEIGHTS.issue;

    return {
      ...e,
      dimensions: {
        multiplier:   Math.round(multiplierNorm[i]),
        critical:     Math.round(criticalNorm[i]),
        consistency:  Math.round(consistencyNorm[i]),
        breadth:      Math.round(breadthNorm[i]),
        acceptance:   Math.round(acceptanceNorm[i]),
        issue:        Math.round(issueNorm[i]),
      },
      score: Math.round(baseScore * (1 - e.revertPenalty)),
    };
  }).sort((a, b) => b.score - a.score);

  const top5 = allScored.slice(0, 5).map(e => ({
    ...e,
    insights: generateInsights(e, allScored, maxWeeks),
  }));

  return {
    weights: WEIGHTS,
    engineers: top5,
    totalEngineers: scored.length,
    totalPRs: all_prs_meta.length,
    since: data.since,
    maxWeeks,
  };
}
