import type { BenefitBundle, BenefitId, BenefitProfile, BenefitRule } from "@/lib/benefit-types";
import type { calculateAdditionalBenefits } from "@/lib/benefit-calculation";

type Calculation = ReturnType<typeof calculateAdditionalBenefits>;
const amount = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(value);
const checked = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value))
  : "확인 시각 없음";

function ruleValue(rule: BenefitRule | undefined, fresh: boolean) {
  if (!fresh || !rule) return "확인 필요";
  if (rule.kind === "percent") return `기본 국비 × ${amount(rule.value)}%`;
  if (rule.kind === "fixed") return `+${amount(rule.value)}만원`;
  return "";
}

export function AdditionalBenefits({ vehicleType, profile, onChange, bundle, calculation, transition }: {
  vehicleType: "passenger" | "cargo";
  profile: BenefitProfile;
  onChange: (profile: BenefitProfile) => void;
  bundle?: BenefitBundle;
  calculation: Calculation;
  transition: boolean;
}) {
  const policy = bundle?.policy;
  const rule = (id: BenefitId) => policy?.rules?.find(item => item.id === id);
  const option = (id: Exclude<BenefitId, "children">, label: string) => (
    <label className="benefit-option" key={id}>
      <input type="checkbox" checked={profile[id]} onChange={event => onChange({ ...profile, [id]: event.target.checked })} />
      <span className="benefit-check" aria-hidden="true">{profile[id] && "✓"}</span>
      <span className="benefit-option-copy"><b>{label}</b><small>{calculation.policyFresh ? rule(id)?.requirement || "공식 자격 요건 확인 필요" : "공식 자격 요건 확인 필요"}</small></span>
      <span className="benefit-value">{ruleValue(rule(id), calculation.policyFresh)}</span>
    </label>
  );
  const childAmounts = calculation.policyFresh ? rule("children")?.childAmounts : undefined;
  return <section className="additional-benefits" aria-label="추가 지원 조건">
    <div className="subsection-heading"><span className="step-number">03</span><h2>추가 지원</h2></div>
    {vehicleType === "passenger" ? <>
      <label className="field benefit-children"><span>대상 자녀 수</span><div className="select-wrap">
        <select aria-label="대상 자녀 수" value={profile.children} onChange={event => onChange({ ...profile, children: Number(event.target.value) as BenefitProfile["children"] })}>
          <option value="0">해당 없음</option>
          {([2, 3, 4] as const).map(count => <option key={count} value={count}>{count === 4 ? "4명 이상" : `${count}명`}{childAmounts?.[count] !== undefined ? ` · +${amount(childAmounts[count])}만원` : ""}</option>)}
        </select><span className="benefit-select-arrow" aria-hidden="true">⌄</span>
      </div><small className="benefit-child-requirement">{calculation.policyFresh ? rule("children")?.requirement || "공식 자녀 요건 확인 필요" : "공식 자녀 요건 확인 필요"}</small></label>
      {option("youth", "청년 · 생애 최초")}
      {option("taxi", "택시용")}
    </> : <>
      {option("smallBusiness", "소상공인")}
      {option("delivery", "택배용")}
    </>}
    {vehicleType === "passenger" && (profile.youth || transition) && <p className="benefit-mutual-note">생애 최초와 전환지원금은 함께 적용하지 않아요.</p>}
    {!calculation.policyFresh && <p className="benefit-quiet-note" role="status">최신 추가 지원 기준 확인 필요</p>}
  </section>;
}

export function AdditionalBenefitBreakdown({ calculation }: { calculation: Calculation }) {
  if (!calculation.hasSelection) return null;
  return <div className="benefit-breakdown">
    <dl>{calculation.lines.map(line => <div key={line.id} className={`benefit-line ${line.state}`}>
      <dt>{line.label}</dt><dd>{line.state === "estimated" ? `+${amount(line.amount)}만원` : line.state === "not-applicable" ? "대상 아님" : "확인 필요"}</dd>
      {line.state !== "estimated" && <dd className="benefit-line-detail">{line.detail}</dd>}
    </div>)}</dl>
    <p>추가액의 국비·지방비 분담은 공고 기준</p>
  </div>;
}

export function LocalBenefitReview({ bundle, profile, year, regionName }: { bundle?: BenefitBundle; profile: BenefitProfile; year: number; regionName: string }) {
  const local = bundle?.local;
  const ids = new Set<BenefitId>([
    ...(profile.children ? ["children" as const] : []), ...(profile.youth ? ["youth" as const] : []),
    ...(profile.smallBusiness ? ["smallBusiness" as const] : []), ...(profile.delivery ? ["delivery" as const] : []), ...(profile.taxi ? ["taxi" as const] : []),
  ]);
  const timestamp = Date.parse(local?.checkedAt ?? "");
  const live = local?.sourceStatus === "live" && local.year === year && Number.isFinite(timestamp) && timestamp <= Date.now() + 5 * 60_000 && Date.now() - timestamp <= 30 * 60_000;
  const selectedSignals = live ? (local.signals || [])
    .filter(signal => ids.has(signal.id as BenefitId))
    .filter((signal, index, signals) => signals.findIndex(item => item.excerpt === signal.excerpt) === index) : [];
  return <section className="local-benefit-review" aria-label="지자체 추가 지원 공고">
    <div className="local-benefit-heading"><h3>{regionName} 추가 지원</h3><span>{live ? "공고 조건 확인" : "최신 공고 확인 필요"}</span></div>
    {live && <p className="local-benefit-time">공고 확인 {checked(local.checkedAt)} · 한국시간</p>}
    {selectedSignals.map(signal => <div className="local-benefit-signal" key={signal.id}><b>{signal.label}</b><p>{signal.excerpt}</p></div>)}
    <p className="benefit-quiet-note">{profile.taxi || profile.delivery ? `${profile.taxi ? '택시' : '택배'} 별도 지원은 지자체마다 달라 합계에 포함하지 않았어요.` : '지자체 별도 지원은 예상 합계에 포함하지 않았어요.'}</p>
    {local?.notices?.length ? <details className="benefit-notices"><summary>지역 공고 {local.notices.length}건</summary><div>{local.notices.map(notice => <a key={notice.code} href={notice.downloadUrl} target="_blank" rel="noopener noreferrer">{notice.label}<span aria-hidden="true">↗</span></a>)}</div></details> : local?.sourceUrl ? <a className="benefit-source-link" href={local.sourceUrl} target="_blank" rel="noopener noreferrer">지자체 공고 보기 <span aria-hidden="true">↗</span></a> : null}
  </section>;
}

export function BenefitPolicyVerification({ bundle, fresh }: { bundle?: BenefitBundle; fresh: boolean }) {
  const policy = bundle?.policy;
  return <section className="benefit-policy-verification">
    <h3>추가 지원 기준</h3>
    <p>{fresh && policy ? policy.revision : "최신 공식 지침 확인 필요"}</p>
    {policy && <p>{checked(policy.checkedAt)} · 한국시간</p>}
    <p>선택한 조건을 충족하는 경우의 예상액이며, 자격·증빙과 지자체 공고에 따라 달라질 수 있어요.</p>
    {policy?.sourceUrl && <a className="benefit-source-link" href={policy.sourceUrl} target="_blank" rel="noopener noreferrer">공식 사업 지침 <span aria-hidden="true">↗</span></a>}
    {policy?.documentUrl && <a className="benefit-source-link" href={policy.documentUrl} target="_blank" rel="noopener noreferrer">지침 원문 파일 <span aria-hidden="true">↗</span></a>}
  </section>;
}
