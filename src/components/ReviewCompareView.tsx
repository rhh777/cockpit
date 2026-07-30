import { useMemo, useState } from 'react'
import type { ReviewIssueDTO, ReviewIssueOutcome, ReviewIssueSetDTO, ReviewRoomState } from '../lib/api'
import type { AgentName } from '../lib/types'
import { labelForAgent } from '../lib/agents'
import { useI18n, type MessageKey } from '../lib/i18n'
import { AgentIcon } from './AgentIcon'
import { Icon } from './Icon'

// 只存 message key,显示时经 t() 取。
const OUTCOME_LABEL: Record<ReviewIssueOutcome, MessageKey> = {
  verified: 'compare.outcomeVerified',
  'still-broken': 'compare.outcomeStillBroken',
  'needs-discussion': 'compare.outcomeNeedsDiscussion',
}

function FollowupResults({
  followupSets,
  issueTitleById,
}: {
  followupSets: { round: { id: string; kind: string; mode: string }; set: ReviewIssueSetDTO }[]
  issueTitleById: Map<string, string>
}) {
  const { t } = useI18n()
  return (
    <div className="review-followup">
      <div className="review-followup-title">{t('compare.followupTitle')}</div>
      {followupSets.map(({ round, set }) => (
        <div key={round.id} className="review-followup-round">
          <div className="review-followup-round-head">
            <span className="review-followup-kind">{round.kind === 'fix' ? 'Fix' : 'Verify'}</span>
            <span className="review-followup-mode">{round.mode}</span>
          </div>
          {set.issues.length === 0 ? (
            <div className="review-compare-empty">{t('compare.noStructured')}</div>
          ) : (
            <div className="review-followup-list">
              {set.issues.map((it) => (
                <div key={`${it.agent}:${it.id}`} className={`review-followup-item ${it.outcome ?? ''}`}>
                  {it.outcome && (
                    <span className={`review-outcome sev-${it.outcome}`}>{t(OUTCOME_LABEL[it.outcome])}</span>
                  )}
                  <div className="review-followup-item-main">
                    <div className="review-followup-item-head">
                      <AgentIcon source={it.agent} size={14} />
                      <span className="review-cluster-issue-agent">{labelForAgent(it.agent)}</span>
                      {it.refIssueIds?.map((rid) => (
                        <span key={rid} className="review-followup-ref" title={issueTitleById.get(rid) ?? ''}>
                          → {issueTitleById.get(rid) ? `${rid} · ${issueTitleById.get(rid)}` : rid}
                        </span>
                      ))}
                    </div>
                    {it.body && <div className="review-cluster-issue-body">{it.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3 }
const SEVERITY_LABEL: Record<string, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' }

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s\/.\-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Jaccard on token bag + path shortcut。相同 path+line 直接算高分。
function similarity(a: ReviewIssueDTO, b: ReviewIssueDTO): number {
  if (a.path && b.path && a.path === b.path) {
    if (a.line && b.line && a.line === b.line) return 1
    // same file, close lines
    if (a.line && b.line && Math.abs(a.line - b.line) <= 5) return 0.85
    // same file, no lines
    if (!a.line && !b.line) return 0.7
  }
  const ta = new Set(normalize(a.title + ' ' + a.body).split(' ').filter((w) => w.length > 2))
  const tb = new Set(normalize(b.title + ' ' + b.body).split(' ').filter((w) => w.length > 2))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  return inter / (ta.size + tb.size - inter)
}

interface ClusterEntry {
  key: string
  issues: ReviewIssueDTO[]
  agents: Set<AgentName>
  worstSeverity: string
  primaryTitle: string
}

function clusterIssues(issues: ReviewIssueDTO[], threshold = 0.5): ClusterEntry[] {
  const clusters: ClusterEntry[] = []
  for (const it of issues) {
    let best: { c: ClusterEntry; score: number } | null = null
    for (const c of clusters) {
      let s = 0
      for (const other of c.issues) s = Math.max(s, similarity(it, other))
      if (s >= threshold && (!best || s > best.score)) best = { c, score: s }
    }
    if (best) {
      best.c.issues.push(it)
      best.c.agents.add(it.agent as AgentName)
      if (SEVERITY_ORDER[it.severity] < SEVERITY_ORDER[best.c.worstSeverity]) {
        best.c.worstSeverity = it.severity
        best.c.primaryTitle = it.title
      }
    } else {
      clusters.push({
        key: `${it.agent}:${it.id}`,
        issues: [it],
        agents: new Set([it.agent as AgentName]),
        worstSeverity: it.severity,
        primaryTitle: it.title,
      })
    }
  }
  return clusters.sort((a, b) => {
    const shared = Number(b.agents.size > 1) - Number(a.agents.size > 1)
    if (shared !== 0) return shared
    return SEVERITY_ORDER[a.worstSeverity] - SEVERITY_ORDER[b.worstSeverity]
  })
}

export function ReviewCompareView({
  room,
  onExtract,
  onFreshReview,
  busy,
  freshBusy,
}: {
  room: ReviewRoomState
  onExtract: () => void
  onFreshReview?: () => void
  busy?: boolean
  freshBusy?: boolean
}) {
  const { t } = useI18n()
  const reviewRounds = room.rounds.filter((r) => r.kind === 'review' && r.status === 'completed')
  const followupRounds = room.rounds.filter(
    (r) => (r.kind === 'fix' || r.kind === 'verify') && r.status === 'completed',
  )
  const initial = reviewRounds.at(-1)?.id
  const [selectedRoundId, setSelectedRoundId] = useState<string | undefined>(initial)
  const activeRoundId = selectedRoundId && reviewRounds.some((r) => r.id === selectedRoundId)
    ? selectedRoundId
    : initial
  const followupSets = followupRounds
    .map((r) => ({ round: r, set: room.issueSets.find((s) => s.roundId === r.id) }))
    .filter((x): x is { round: typeof followupRounds[number]; set: ReviewIssueSetDTO } => !!x.set)
  const outcomesByIssueId = useMemo(() => {
    // 收集每个父 issue 上被 fix/verify 打过的 outcome 轨迹(按轮次时间序)。
    const map = new Map<string, { round: string; kind: string; agent: string; outcome: ReviewIssueOutcome }[]>()
    followupSets.forEach(({ round, set }, idx) => {
      for (const it of set.issues) {
        if (!it.outcome || !it.refIssueIds) continue
        for (const rid of it.refIssueIds) {
          const list = map.get(rid) ?? []
          list.push({ round: `#${idx + 1}`, kind: round.kind, agent: it.agent, outcome: it.outcome })
          map.set(rid, list)
        }
      }
    })
    return map
  }, [followupSets])

  const set: ReviewIssueSetDTO | undefined = useMemo(
    () => room.issueSets.find((s) => s.roundId === activeRoundId),
    [room.issueSets, activeRoundId],
  )
  const clusters = useMemo(() => (set ? clusterIssues(set.issues) : []), [set])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const runningReview = room.rounds.find((r) => r.kind === 'review' && r.status === 'running')
  if (reviewRounds.length === 0) {
    if (runningReview) {
      const started = new Date(runningReview.startedAt).getTime()
      const minutes = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 60000)) : null
      return (
        <div className="review-compare in-progress">
          <div className="review-compare-head">
            <div className="review-compare-title">
              <Icon name="wrench" size={13} />
              <span>{t('compare.reviewRunning')}</span>
            </div>
            {minutes !== null && (
              <span className="review-compare-empty">
                {t('compare.startedAgo', {
                  when: minutes < 1 ? t('compare.justNow') : t('compare.minutesAgo', { count: minutes }),
                  mode: runningReview.mode,
                  agents: runningReview.agents.map(labelForAgent).join(', '),
                })}
              </span>
            )}
          </div>
          <div className="review-compare-empty">
            {t('compare.runningHint')}
          </div>
        </div>
      )
    }
    return (
      <div className="review-compare-empty">
        {t('compare.noRounds')}
      </div>
    )
  }
  if (!set) {
    return (
      <div className="review-compare-empty">
        {t('compare.noFindings')}
        <div style={{ marginTop: 8 }}>
          <button className="modal-btn" onClick={onExtract} disabled={busy}>
            {busy ? t('compare.extracting') : t('compare.reExtract')}
          </button>
        </div>
      </div>
    )
  }

  const perAgent = new Map<AgentName, ReviewIssueDTO[]>()
  for (const it of set.issues) {
    const list = perAgent.get(it.agent as AgentName) ?? []
    list.push(it)
    perAgent.set(it.agent as AgentName, list)
  }
  const agents = [...perAgent.keys()]

  return (
    <div className="review-compare">
      <div className="review-compare-head">
        <div className="review-compare-title">
          <Icon name="wrench" size={13} />
          <span>Compare</span>
        </div>
        {reviewRounds.length > 1 && (
          <select
            className="review-compare-round"
            value={activeRoundId}
            onChange={(e) => setSelectedRoundId(e.target.value)}
          >
            {reviewRounds.map((r, i) => (
              <option key={r.id} value={r.id}>
                Round {i + 1} · {r.mode}
              </option>
            ))}
          </select>
        )}
        <button className="modal-btn" onClick={onExtract} disabled={busy}>
          {busy ? t('compare.extracting') : t('compare.reExtract')}
        </button>
        {onFreshReview && (
          <button
            className="modal-btn primary"
            onClick={onFreshReview}
            disabled={freshBusy}
            title={t('compare.freshReviewHint')}
          >
            {freshBusy ? t('compare.generating') : t('compare.freshReview')}
          </button>
        )}
      </div>

      <div className="review-compare-stats">
        {agents.map((a) => (
          <div className="review-compare-stat" key={a}>
            <AgentIcon source={a} size={16} />
            <span>{labelForAgent(a)}</span>
            <span className="review-compare-stat-count">{perAgent.get(a)?.length ?? 0}</span>
          </div>
        ))}
        <div className="review-compare-stat">
          <span>{t('compare.consensusStat')}</span>
          <span className="review-compare-stat-count">{clusters.filter((c) => c.agents.size > 1).length}</span>
        </div>
      </div>

      {set.recommendedNextStep && (
        <div className="review-compare-next">
          <strong>{t('compare.nextStep')}</strong>&nbsp;{set.recommendedNextStep}
        </div>
      )}

      {clusters.length === 0 ? (
        <div className="review-compare-empty">{t('compare.allEmpty')}</div>
      ) : (
        <div className="review-compare-list">
          {clusters.map((c) => {
            const shared = c.agents.size > 1
            const open = expanded.has(c.key)
            const clusterOutcomes = c.issues.flatMap((it) => outcomesByIssueId.get(it.id) ?? [])
            const latestOutcome = clusterOutcomes.at(-1)
            return (
              <div
                key={c.key}
                className={`review-cluster ${shared ? 'shared' : ''} sev-${c.worstSeverity}`}
              >
                <button
                  type="button"
                  className="review-cluster-head"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(c.key)) next.delete(c.key)
                      else next.add(c.key)
                      return next
                    })
                  }
                  aria-expanded={open}
                >
                  <span className={`review-sev sev-${c.worstSeverity}`}>{SEVERITY_LABEL[c.worstSeverity] ?? c.worstSeverity}</span>
                  <span className="review-cluster-title">
                    {c.primaryTitle}
                    {latestOutcome && (
                      <span
                        className={`review-outcome sev-${latestOutcome.outcome} inline`}
                        title={`${latestOutcome.round} ${latestOutcome.kind} · ${labelForAgent(latestOutcome.agent as AgentName)}`}
                      >
                        {t(OUTCOME_LABEL[latestOutcome.outcome])}
                      </span>
                    )}
                  </span>
                  <span className="review-cluster-agents">
                    {[...c.agents].map((a) => (
                      <AgentIcon key={a} source={a} size={14} />
                    ))}
                  </span>
                  <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
                    <Icon name="chevron-right" size={12} />
                  </span>
                </button>
                {open && (
                  <div className="review-cluster-body">
                    {clusterOutcomes.length > 0 && (
                      <div className="review-cluster-trail">
                        {clusterOutcomes.map((o, i) => (
                          <span key={i} className="review-cluster-trail-item">
                            {o.round} {o.kind} · {labelForAgent(o.agent as AgentName)}{' '}
                            <span className={`review-outcome sev-${o.outcome}`}>{t(OUTCOME_LABEL[o.outcome])}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {c.issues.map((it) => (
                      <div key={`${it.agent}:${it.id}`} className="review-cluster-issue">
                        <div className="review-cluster-issue-head">
                          <AgentIcon source={it.agent} size={14} />
                          <span className="review-cluster-issue-agent">{labelForAgent(it.agent)}</span>
                          <span className={`review-sev sev-${it.severity}`}>{SEVERITY_LABEL[it.severity] ?? it.severity}</span>
                          {it.path && (
                            <code className="review-cluster-issue-path">
                              {it.path}
                              {it.line ? `:${it.line}` : ''}
                            </code>
                          )}
                        </div>
                        <div className="review-cluster-issue-title">{it.title}</div>
                        {it.body && <div className="review-cluster-issue-body">{it.body}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {followupSets.length > 0 && (
        <FollowupResults
          followupSets={followupSets}
          issueTitleById={new Map(set.issues.map((i) => [i.id, i.title]))}
        />
      )}

      {room.freshReviews && room.freshReviews.length > 0 && (
        <div className="review-fresh-list">
          <div className="review-followup-title">Fresh reviews</div>
          {room.freshReviews.map((f) => (
            <a key={f.childReviewRoomId} className="review-fresh-item" href={`/cockpit/${encodeURIComponent(f.childReviewRoomId)}`}>
              <span>→ {f.reviewerAgents.map(labelForAgent).join(', ')}</span>
              <span className="review-cluster-issue-path">{f.reason}</span>
            </a>
          ))}
        </div>
      )}

      {(set.agreements.length > 0 || set.disagreements.length > 0) && (
        <div className="review-compare-meta">
          {set.agreements.length > 0 && (
            <div className="review-compare-meta-block">
              <div className="review-compare-meta-title">Agreements</div>
              <ul>
                {set.agreements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {set.disagreements.length > 0 && (
            <div className="review-compare-meta-block">
              <div className="review-compare-meta-title">Disagreements</div>
              <ul>
                {set.disagreements.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
