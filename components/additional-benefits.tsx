import type { BenefitBundle, BenefitId, BenefitProfile, BenefitRule } from "@/lib/benefit-types";
import type { calculateAdditionalBenefits } from "@/lib/benefit-calculation";

type Calculation = ReturnType<typeof calculateAdditionalBenefits>;
type BooleanCondition = Exclude<keyof BenefitProfile, "children">;
const amount = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(value);
const checked = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value))
  : "확인 시각 없음";
const freshAt = (value: string | null | undefined) => {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 5 * 60_000 && Date.now() - timestamp <= 30 * 60_000;
};

function ruleValue(rule: BenefitRule | undefined, fresh: boolean) {
  if (!fresh || !rule) return "확인 필요";
  if (rule.kind === "percent") return `기본 국비 × ${amount(rule.value)}%`;
  if (rule.kind === "fixed") return `+${amount(rule.value)}만원`;
  return "";
}

export function AdditionalBenefits({ vehicleType, category, categoryCode, profile, onChange, bundle, calculation, transition }: {
  vehicleType: "passenger" | "cargo";
  category: string;
  categoryCode: string;
  profile: BenefitProfile;
  onChange: (profile: BenefitProfile) => void;
  bundle?: BenefitBundle;
  calculation: Calculation;
  transition: boolean;
}) {
  const policy = bundle?.policy;
  const rule = (id: BenefitId) => policy?.rules?.find(item => item.id === id);
  const option = (field: BooleanCondition, id: Exclude<BenefitId, "children">, label: string) => {
    const inputId = `benefit-${id}`;
    return <label className="benefit-option" key={id} htmlFor={inputId}>
      <input id={inputId} type="checkbox" checked={profile[field]} aria-labelledby={`${inputId}-label`} aria-describedby={`${inputId}-requirement ${inputId}-value`} onChange={event => onChange({ ...profile, [field]: event.target.checked })} />
      <span className="benefit-check" aria-hidden="true">{profile[field] && "✓"}</span>
      <span className="benefit-option-copy"><b id={`${inputId}-label`}>{label}</b><small id={`${inputId}-requirement`}>{calculation.policyFresh ? rule(id)?.requirement || "공식 자격 요건 확인 필요" : "공식 자격 요건 확인 필요"}</small></span>
      <span id={`${inputId}-value`} className="benefit-value">{ruleValue(rule(id), calculation.policyFresh)}</span>
    </label>;
  };
  const childAmounts = calculation.policyFresh ? rule("children")?.childAmounts : undefined;
  const micro = /초소형/.test(category) || categoryCode === "TRUCKSSML";
  const scope = vehicleType === "passenger" ? micro ? "passenger-micro" : "passenger-standard" : micro ? "cargo-micro" : null;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const reviewRules = calculation.policyFresh ? (policy?.reviewRules || []).filter(item => scope && item.scopes.includes(scope) && (!item.expiresOn || item.expiresOn >= today)) : [];
  return <section className="additional-benefits" aria-label="추가 지원 조건">
    <div className="subsection-heading"><span className="step-number">03</span><h2>내 추가 지원</h2></div>
    {vehicleType === "passenger" ? <>
      <label className="field benefit-children"><span>대상 자녀 수</span><div className="select-wrap">
        <select aria-label="대상 자녀 수" aria-describedby="benefit-children-requirement" value={profile.children} onChange={event => onChange({ ...profile, children: Number(event.target.value) as BenefitProfile["children"] })}>
          <option value="0">해당 없음</option>
          {([2, 3, 4] as const).map(count => <option key={count} value={count}>{count === 4 ? "4명 이상" : `${count}명`}{childAmounts?.[count] !== undefined ? ` · +${amount(childAmounts[count])}만원` : ""}</option>)}
        </select><span className="benefit-select-arrow" aria-hidden="true">⌄</span>
      </div><small id="benefit-children-requirement" className="benefit-child-requirement">{calculation.policyFresh ? rule("children")?.requirement || "공식 자녀 요건 확인 필요" : "공식 자녀 요건 확인 필요"}</small></label>
      {option("youth", "youth", "청년 · 생애 최초")}
      {option("lowIncome", "lowIncomePassenger", "기초생활수급자 · 차상위")}
    </> : <>
      {option("lowIncome", "lowIncomeCargo", "기초생활수급자 · 차상위")}
      {option("farmer", "farmer", "농업인")}
    </>}
    <details className="benefit-more-conditions">
      <summary>{vehicleType === "passenger" ? "택시·기타 지원" : "소상공인·택배·기타 지원"}<span>{vehicleType === "passenger" ? profile.taxi ? "1개 선택" : "" : profile.smallBusiness || profile.delivery ? `${Number(profile.smallBusiness) + Number(profile.delivery)}개 선택` : ""}</span></summary>
      {vehicleType === "passenger" ? option("taxi", "taxi", "택시용") : <>{option("smallBusiness", "smallBusiness", "소상공인")}{option("delivery", "delivery", "택배용")}</>}
      {reviewRules.length > 0 && <div className="benefit-review-programs"><p>별도 신청·확인 · 합계 미포함</p>{reviewRules.map(item => <article key={item.id}><div><b>{item.label}</b><span>{item.amountLabel}</span></div><p>{item.requirement}</p>{item.expiresOn && <small>{item.expiresOn.replaceAll("-", ".")}까지</small>}</article>)}</div>}
    </details>
    {vehicleType === "passenger" && (profile.youth || transition) && <p className="benefit-mutual-note">생애 최초와 전환지원금은 함께 적용하지 않아요.</p>}
    {vehicleType === "cargo" && profile.lowIncome && profile.smallBusiness && <p className="benefit-mutual-note">기초·차상위와 소상공인 가산은 한 번만 적용해요.</p>}
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

export function BenefitCoverageSummary({ bundle, calculation, checkedAt, baseVerified, sourceStatus, refreshing, year }: {
  bundle?: BenefitBundle; calculation: Calculation; checkedAt?: string | null; baseVerified: boolean;
  sourceStatus?: "live" | "cached" | "unavailable"; refreshing: boolean; year: number;
}) {
  const baseFresh = sourceStatus === "live" && freshAt(checkedAt);
  const local = bundle?.local;
  const localFresh = local?.sourceStatus === "live" && local.year === year && freshAt(local.checkedAt);
  return <div className="benefit-coverage" aria-label="정보별 확인 상태">
    <div className={baseFresh && baseVerified ? "coverage-current" : "coverage-pending"}><span>기본 금액</span><b>{refreshing ? "다시 확인 중" : baseFresh && baseVerified ? "원문 대조" : sourceStatus === "cached" ? "이전 정보" : "확인 필요"}</b><small>{checkedAt ? `${checked(checkedAt)} 확인` : "연결 확인 필요"}</small></div>
    <div className={calculation.policyFresh ? "coverage-current" : "coverage-pending"}><span>국가 추가 기준</span><b>{calculation.policyFresh ? "최신 지침" : "확인 필요"}</b><small>{calculation.policyFresh ? `${checked(bundle?.policy.checkedAt)} 확인` : "미확인 항목 합산 안 함"}</small></div>
    <div className="coverage-pending"><span>지역 별도 지원</span><b>합계 미포함</b><small>{localFresh ? `공고 목록 ${checked(local.checkedAt)} 확인` : "최신 공고 확인 필요"}</small></div>
  </div>;
}

export function LocalBenefitReview({ bundle, profile, year, regionName }: { bundle?: BenefitBundle; profile: BenefitProfile; year: number; regionName: string }) {
  const local = bundle?.local;
  const ids = new Set<BenefitId>([
    ...(profile.children ? ["children" as const] : []), ...(profile.youth ? ["youth" as const] : []),
    ...(profile.smallBusiness ? ["smallBusiness" as const] : []), ...(profile.delivery ? ["delivery" as const] : []), ...(profile.taxi ? ["taxi" as const] : []),
    ...(profile.lowIncome ? ["lowIncomePassenger" as const, "lowIncomeCargo" as const] : []), ...(profile.farmer ? ["farmer" as const] : []),
  ]);
  const live = local?.sourceStatus === "live" && local.year === year && freshAt(local.checkedAt);
  const signals = live ? (local.signals || []).filter((signal, index, items) => items.findIndex(item => item.excerpt === signal.excerpt) === index) : [];
  const strongKinds = new Set(["restriction", "deduction", "closure", "program"]);
  const relevant = signals.filter(signal => strongKinds.has(signal.kind || "") || ids.has(signal.id as BenefitId));
  const highlights = relevant.filter(signal => strongKinds.has(signal.kind || ""));
  const highlightLabels = [...new Set(highlights.map(signal => signal.label))].slice(0, 3);
  const detailsSignals = relevant.length ? relevant : signals;
  return <section className="local-benefit-review" aria-label="지자체 추가 지원 공고">
    <div className="local-benefit-heading"><h3>{regionName} 별도 지원</h3><span>{live ? "공고별 확인 필요" : "최신 공고 확인 필요"}</span></div>
    <p className="benefit-quiet-note">지역별 추가금·중복 조건은 합계에 포함하지 않았어요.</p>
    {highlightLabels.length > 0 && <div className="local-benefit-highlights" aria-label="확인할 지역 조건">{highlightLabels.map(label => <span key={label}>{label}</span>)}</div>}
    {live && <p className="local-benefit-time">공고 목록 확인 {checked(local.checkedAt)} · 한국시간</p>}
    <details className="benefit-notices"><summary>지역 조건·공고 보기{local?.notices?.length ? <span>{local.notices.length}건</span> : null}</summary><div className="local-benefit-details">
      {detailsSignals.map((signal, index) => <div className="local-benefit-signal" key={`${signal.id}-${index}`}><b>{signal.label}</b><p>{signal.excerpt}</p></div>)}
      {detailsSignals.length > 0 && <p className="benefit-quiet-note">공고에서 찾은 관련 문구예요. 개별 지급 가능 여부와 금액은 공고 원문을 확인해 주세요.</p>}
      {local?.notices?.map(notice => <a key={notice.code} href={notice.downloadUrl} target="_blank" rel="noopener noreferrer">{notice.label}<span aria-hidden="true">↗</span></a>)}
      {local?.sourceUrl && <a href={local.sourceUrl} target="_blank" rel="noopener noreferrer">공식 지자체 공고 목록<span aria-hidden="true">↗</span></a>}
      {!local?.sourceUrl && !local?.notices?.length && <p className="benefit-quiet-note">공식 공고 연결을 다시 확인하고 있어요.</p>}
    </div></details>
  </section>;
}

export function BenefitPolicyVerification({ bundle, fresh }: { bundle?: BenefitBundle; fresh: boolean }) {
  const policy = bundle?.policy;
  return <section className="benefit-policy-verification">
    <h3>국가 추가 지원 기준</h3>
    <p>{fresh && policy ? policy.revision : "최신 공식 지침 확인 필요"}</p>
    {policy && <p>{checked(policy.checkedAt)} · 한국시간</p>}
    <p>선택한 조건을 충족하는 경우의 예상액이에요. 지자체 별도 지원금의 지급 가능 여부·금액까지 확인됐다는 뜻은 아니에요.</p>
    {policy?.sourceUrl && <a className="benefit-source-link" href={policy.sourceUrl} target="_blank" rel="noopener noreferrer">공식 사업 지침 <span aria-hidden="true">↗</span></a>}
    {policy?.documentUrl && <a className="benefit-source-link" href={policy.documentUrl} target="_blank" rel="noopener noreferrer">지침 원문 파일 <span aria-hidden="true">↗</span></a>}
  </section>;
}
