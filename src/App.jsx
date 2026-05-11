import { useState, useEffect } from 'react'
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts'
import { computeImpact } from './analysis.js'
import './App.css'

const DIMS = {
  multiplier: {
    label: 'Review Activity',
    short: 'REV',
    why: 'Code review is how engineers multiply each other\'s output. Fast, substantive reviews compress team cycle time — and engineers who actually block bad code (CHANGES_REQUESTED) are worth more than rubber-stampers.',
    formula: 'weighted_reviews × speed_factor → normalized 0–100. State weights: CHANGES_REQUESTED 1.5×, APPROVED 1.0×, COMMENTED 0.8×, DISMISSED 0.3×. Speed factor = (max(0, 100 − log₁ₚ(avg_hours_from_assignment) × 15) / 100) + 0.5, ranging 0.5–1.5.',
  },
  critical: {
    label: 'Critical Path',
    short: 'CRT',
    why: 'Not all code is equal. Engineers who consistently work on high-traffic shared files — the ones everyone else builds on — have outsized leverage on the whole codebase.',
    formula: 'avg( log(1 + PR_count_per_file) ) across all files in merged PRs → normalized 0–100. Files touched by more PRs (higher traffic) score higher.',
  },
  consistency: {
    label: 'Consistency',
    short: 'CON',
    why: 'Reliability compounds. An engineer who ships every single week for 13 weeks is fundamentally different from one who bursts for 3 weeks and disappears — even if their total PR count is the same.',
    formula: 'distinct_weeks_with_≥1_merged_PR ÷ max_weeks_any_engineer_achieved → normalized 0–100. Covers the full 90-day window.',
  },
  breadth: {
    label: 'Breadth',
    short: 'BRD',
    why: 'Engineers who contribute across multiple domains reduce knowledge silos and are harder to lose. Specialists still score well on depth — breadth rewards those who additionally extend their reach across the codebase.',
    formula: 'unique_dirs × prs_in_sample^0.15 → normalized 0–100. Unique directories still dominate; the small volume exponent gives a marginal bonus to engineers who sustain broad contributions over many PRs.',
  },
  acceptance: {
    label: 'Acceptance Rate',
    short: 'ACC',
    why: 'A high merge rate signals disciplined, well-scoped work. Engineers who open PRs that ship reliably waste less of their team\'s review time and keep the codebase moving forward.',
    formula: 'merged_PRs ÷ (merged_PRs + closed_unmerged_PRs) → normalized 0–100. Both counts cover the full 90-day window.',
  },
  issue: {
    label: 'Issue Resolution',
    short: 'ISS',
    why: 'The best engineers don\'t just ship features — they respond to real user pain. Engaging with bugs and improvements shows ownership beyond your own ticket queue.',
    formula: '(issues_resolved × 2 + issues_engaged × 0.5) → normalized 0–100. "Resolved" = authored the PR that closed a bug/enhancement issue. "Engaged" = commented on one that was eventually closed.',
  },
}

const COLORS = ['#E8440A', '#0284C7', '#059669', '#7C3AED', '#D97706']

function ScoreArc({ score, color }) {
  const cx = 40, cy = 40, r = 28, sw = 3.5
  const toXY = deg => {
    const rad = deg * Math.PI / 180
    return { x: +(cx + r * Math.cos(rad)).toFixed(2), y: +(cy + r * Math.sin(rad)).toFixed(2) }
  }
  const ts = toXY(135), te = toXY(45)
  const psweep = 270 * score / 100
  const pe = toXY(135 + psweep)

  return (
    <svg width="80" height="80" className="score-arc" role="img" aria-label={`Score ${score}`}>
      <path d={`M ${ts.x} ${ts.y} A ${r} ${r} 0 1 1 ${te.x} ${te.y}`}
        fill="none" stroke="#E8E3DA" strokeWidth={sw} strokeLinecap="round" />
      {score > 1 && (
        <path d={`M ${ts.x} ${ts.y} A ${r} ${r} 0 ${psweep > 180 ? 1 : 0} 1 ${pe.x} ${pe.y}`}
          fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
      <text x={cx} y={cy + 7} textAnchor="middle" className="arc-num">{score}</text>
    </svg>
  )
}

function DimBar({ short, value, color }) {
  return (
    <div className="dim">
      <span className="dim-tag">{short}</span>
      <div className="dim-track"><div className="dim-fill" style={{ width: `${value}%`, background: color }} /></div>
      <span className="dim-val">{value}</span>
    </div>
  )
}

function EngCard({ eng, rank, color, selected, onClick }) {
  return (
    <article
      className={`card${selected ? ' card--sel' : ''}${rank === 1 ? ' card--top' : ''}`}
      style={{ '--c': color }}
      onClick={onClick}
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-pressed={selected}
    >
      <div className="card-rank">#{rank}</div>
      <div className="card-hero">
        <div className="card-av-wrap">
          <img className="card-av"
            src={`https://github.com/${eng.login}.png?size=64`} alt=""
            loading="lazy"
            onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(eng.login[0])}&background=e8e3da&color=999&size=64` }}
          />
        </div>
        <ScoreArc score={eng.score} color={color} />
      </div>
      <a className="card-login"
        href={`https://github.com/${eng.login}`} target="_blank" rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}>
        {eng.login}
      </a>
      <div className="card-meta">
        <span><b>{eng.prsAuthored}</b><em>merged</em></span>
        <span><b>{eng.totalPRsOpened > eng.prsAuthored ? eng.totalPRsOpened : eng.prsAuthored}</b><em>opened</em></span>
        <span><b>{eng.reviewsGiven}</b><em>reviews</em></span>
        <span><b>{eng.dirsCount}</b><em>areas</em></span>
      </div>
      <div className="card-dims">
        {Object.keys(DIMS).map(k => (
          <DimBar key={k} short={DIMS[k].short} value={eng.dimensions[k]} color={color} />
        ))}
      </div>
    </article>
  )
}

const RadarTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null
  const dim = payload[0]?.payload?.dim
  return (
    <div className="ctip">
      <div className="ctip-label">{dim}</div>
      {payload.map(p => (
        <div key={p.name} className="ctip-row">
          <span className="ctip-dot" style={{ background: p.color }} />
          <span className="ctip-name">{p.name}</span>
          <b className="ctip-val">{Math.round(p.value)}</b>
        </div>
      ))}
    </div>
  )
}

function CompareChart({ engineers, selIdx, onSel }) {
  const data = Object.keys(DIMS).map(k => ({
    dim: DIMS[k].label,
    ...Object.fromEntries(engineers.map(e => [e.login, e.dimensions[k]])),
  }))

  return (
    <section className="compare">
      <div className="compare-head">
        <span className="sec-title">Dimension Breakdown</span>
        <div className="compare-legend">
          {engineers.map((e, i) => (
            <button key={e.login}
              className={`legend-btn${selIdx === i ? ' legend-btn--sel' : ''}`}
              style={{ '--lc': COLORS[i] }}
              onClick={() => onSel(i)}>
              <span className="legend-dot" />{e.login}
            </button>
          ))}
        </div>
      </div>
      <div className="radar-wrap">
        <ResponsiveContainer width="100%" height={300}>
          <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
            <PolarGrid stroke="#EDE8E0" strokeDasharray="0" />
            <PolarAngleAxis
              dataKey="dim"
              tick={{ fill: '#6B6050', fontSize: 11, fontFamily: "'Manrope', sans-serif", fontWeight: 600 }}
              tickLine={false}
            />
            <PolarRadiusAxis
              angle={90} domain={[0, 100]} tickCount={4}
              tick={{ fill: '#B0A898', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
            />
            {engineers.map((e, i) => (
              <Radar
                key={e.login}
                name={e.login}
                dataKey={e.login}
                stroke={COLORS[i]}
                fill={COLORS[i]}
                fillOpacity={selIdx === null ? 0.12 : selIdx === i ? 0.25 : 0.03}
                strokeOpacity={selIdx === null ? 0.8 : selIdx === i ? 1 : 0.2}
                strokeWidth={selIdx === i ? 2.5 : 1.5}
                style={{ cursor: 'pointer' }}
                onClick={() => onSel(i)}
              />
            ))}
            <Tooltip content={<RadarTip />} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

function Methodology({ weights, totalPRs, selectedEngineer, selIdx }) {
  const [open, setOpen] = useState(false)

  // Auto-open when an engineer is selected
  useEffect(() => {
    if (selectedEngineer) setOpen(true)
  }, [selectedEngineer?.login])

  const isPersonalized = open && selectedEngineer

  return (
    <section className={`method${open ? ' method--open' : ''}`}>
      <button className="method-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>
          How scores are calculated
          {isPersonalized && (
            <span className="method-for"> — showing for <b>{selectedEngineer.login}</b></span>
          )}
        </span>
        <span className="method-caret">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="method-body">
          <div className="method-grid">
            {Object.entries(DIMS).map(([k, d]) => (
              <div key={k} className={`method-item${isPersonalized ? ' method-item--personal' : ''}`}
                style={isPersonalized ? { '--mc': COLORS[selIdx] } : {}}>
                <div className="method-item-top">
                  <span className="method-name">{d.label}</span>
                  <span className="method-pct">{Math.round(weights[k] * 100)}%</span>
                  {isPersonalized && (
                    <span className="method-score" style={{ color: COLORS[selIdx] }}>
                      {selectedEngineer.dimensions[k]}/100
                    </span>
                  )}
                </div>
                <p className="method-why">{d.why}</p>
                <p className="method-formula"><span className="formula-label">Formula: </span>{d.formula}</p>
                {isPersonalized && (
                  <p className="method-insight">{selectedEngineer.insights[k]}</p>
                )}
              </div>
            ))}
          </div>
          {isPersonalized && selectedEngineer.insights.revertNote && (
            <div className="revert-note" style={{ '--mc': COLORS[selIdx] }}>
              <span className="revert-label">Revert quality check</span>
              {selectedEngineer.insights.revertNote}
            </div>
          )}
          <p className="method-note">
            All dimensions are normalized 0–100 across {' '}
            <b>contributors with ≥3 merged PRs</b> in the 90-day window. Bots excluded.
            All signals (files, reviews, timeline, issues) cover the full <b>{totalPRs?.toLocaleString()} merged PRs</b> in this period.
            Composite = 20% Review Activity + 20% Critical Path + 20% Consistency + 15% Breadth + 15% Acceptance Rate + 10% Issue Resolution,
            then adjusted down by revert rate (capped at −25%). Reverts detected across all common title formats (GitHub auto-generated, direct #N references, conventional commit style).
          </p>
        </div>
      )}
    </section>
  )
}

export default function App() {
  const [status, setStatus] = useState('loading')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [sel, setSel] = useState(null)

  useEffect(() => {
    fetch('/data.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(raw => { setResult(computeImpact(raw)); setStatus('ready') })
      .catch(e => { setError(e.message); setStatus('error') })
  }, [])

  const toggle = i => setSel(p => p === i ? null : i)

  if (status === 'loading') return (
    <div className="shell shell--mid">
      <div className="spin" />
      <p className="spin-label">Crunching 90 days of contributor data…</p>
    </div>
  )

  if (status === 'error') return (
    <div className="shell shell--mid">
      <div className="errbox">
        <span className="err-icon">⚠</span>
        <p className="err-title">Could not load <code>data.json</code></p>
        <code className="err-detail">{error}</code>
        <p className="err-hint">Run <code>GITHUB_TOKEN=… node fetch-data.mjs</code> first.</p>
      </div>
    </div>
  )

  const { engineers, weights, totalPRs, totalEngineers, since } = result
  const fmt = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const selectedEngineer = sel !== null ? engineers[sel] : null

  return (
    <div className="shell">
      <header className="hdr">
        <div className="hdr-l">
          <div className="hdr-logo" aria-hidden="true">PH</div>
          <div>
            <h1 className="hdr-title">Engineering Impact</h1>
            <p className="hdr-sub">PostHog · {fmt(since)} – {fmt(new Date())}</p>
          </div>
        </div>
        <div className="hdr-r">
          <div className="hdr-stat"><span className="hs-n">{totalPRs.toLocaleString()}</span><span className="hs-l">PRs merged</span></div>
          <div className="hdr-stat"><span className="hs-n">{totalEngineers}</span><span className="hs-l">contributors</span></div>
          <div className="hdr-stat hdr-stat--hi"><span className="hs-n">90d</span><span className="hs-l">window</span></div>
        </div>
      </header>

      <main className="main">
        <div className="cards">
          {engineers.map((e, i) => (
            <EngCard key={e.login} eng={e} rank={i + 1}
              color={COLORS[i]} selected={sel === i} onClick={() => toggle(i)} />
          ))}
        </div>
        <CompareChart engineers={engineers} selIdx={sel} onSel={toggle} />
        <Methodology
          weights={weights}
          totalPRs={totalPRs}
          selectedEngineer={selectedEngineer}
          selIdx={sel}
        />
      </main>
    </div>
  )
}
