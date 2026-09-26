import type { CodexQuotaWindow, CodexUsageReason, CodexUsageSnapshot } from "../../electron/shared/codex-usage-contract"
import type { Translator } from "../../electron/shared/translations"
import { useT } from "../i18n/useLanguage"
const reasons: Record<CodexUsageReason, string> = {
  "not-signed-in": "Codex 로그인 필요", "api-key-account": "구독 한도 표시 대상 아님", "unsupported-account": "지원하지 않는 계정",
  "cli-missing": "Codex CLI 없음 · 설정에서 연결", "cli-unsupported": "CLI 지원 불가 · 설정에서 확인", "query-failed": "확인 불가", "invalid-response": "확인 불가", "not-provided": "사용량 정보 미제공",
}
export function usagePresentation(snapshot: CodexUsageSnapshot, t: Translator) {
  const scope = t("이 컴퓨터에 연결된 Codex 계정 기준이며, 선택한 작업만의 사용량이 아닙니다.")
  const date = (ms: number) => new Intl.DateTimeFormat(t.locale, { dateStyle: "short", timeStyle: "short" }).format(ms)
  const observed = snapshot.observedAtMs === null ? "" : t`마지막 확인: ${date(snapshot.observedAtMs)}`
  const status = snapshot.state === "loading" ? t("Codex 사용량 확인 중") : snapshot.state === "stale" ? t("오래된 조회값") : snapshot.reason && snapshot.reason !== "not-provided" ? t(reasons[snapshot.reason]) : ""
  const window = (label: string, w: CodexQuotaWindow | null) => {
    const title = t(label), freshness = w?.freshness === "reset-pending" ? t("재확인 중") : w?.freshness === "stale" ? t("오래된 조회값") : ""
    const text = w ? t`${title} ${Math.round(w.usedPercent)}% 사용` : `${title} —`
    const details = w ? [text, t`${Math.round(Math.max(0, 100 - w.usedPercent))}% 남음`, w.resetsAtMs === null ? t("초기화 시각 미제공") : t`다음 초기화: ${date(w.resetsAtMs)}`, freshness] : [t`${title} 정보 미제공`]
    return { text, freshness, description: [...details, observed, scope].filter(Boolean).join(" · ") }
  }
  const windows = [window("5시간", snapshot.fiveHour), window("주간", snapshot.weekly)]
  const limited = snapshot.ordinaryUsageAllowed === false ? t("사용 제한") : ""
  return { windows, status, limited, description: [t("Codex 사용량"), status, limited, ...windows.map(w => w.description)].filter(Boolean).join(" · ") }
}
export function CodexUsageStrip({ snapshot }: { snapshot: CodexUsageSnapshot }) {
  const t = useT()
  if (!snapshot.enabled) return null
  const view = usagePresentation(snapshot, t)
  return <section className="codex-usage" aria-label={t("Codex 사용량")} title={view.description}>
    <div className="codex-usage-heading"><span>{t("Codex 사용량")}</span><span>{[view.status, view.limited].filter(Boolean).join(" · ") || (view.windows.some(w => w.freshness) ? t("재확인 중") : "")}</span></div>
    <div className="codex-usage-windows">{view.windows.map((w, i) => <span key={i} title={w.description} aria-label={w.description}>{w.text}</span>)}</div>
  </section>
}
