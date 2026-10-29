import { amountWithTransition } from './vehicle-configuration';
import type { BenefitBundle, BenefitId, BenefitLine, BenefitProfile, BenefitRule } from './benefit-types';

export type BenefitVehicle = {
  vehicleType: 'passenger' | 'cargo'; categoryCode: string; category: string;
  national: number | null; local: number | null; total: number | null;
  transitionNational: number | null; transitionLocal: number | null;
};
const FRESH_FOR = 30 * 60_000;
const won = (amount: number) => Math.round(amount * 10_000);
const money = (amount: number) => amount / 10_000;
const LABELS: Record<BenefitId, string> = {
  children: '다자녀', youth: '청년 · 생애 최초', smallBusiness: '소상공인', delivery: '택배용', taxi: '전기택시',
};

function applicability(vehicle: BenefitVehicle, rule: BenefitRule): 'yes' | 'no' | 'unknown' {
  if (rule.scope === 'passenger-all') return vehicle.vehicleType === 'passenger' ? 'yes' : 'no';
  if (rule.scope === 'passenger-standard') {
    if (vehicle.vehicleType !== 'passenger') return 'no';
    if (/초소형/.test(vehicle.category)) return 'no';
    return ['RIDE', 'RIDELGT'].includes(vehicle.categoryCode) ? 'yes' : 'unknown';
  }
  if (vehicle.vehicleType !== 'cargo') return 'no';
  return ['TRUCKSML', 'TRUCKLGT', 'TRUCKSSML'].includes(vehicle.categoryCode) ? 'yes' : 'unknown';
}

export function calculateAdditionalBenefits(
  vehicle: BenefitVehicle,
  includeTransition: boolean,
  profile: BenefitProfile,
  bundle: BenefitBundle | null | undefined,
  year: number,
  now = Date.now(),
) {
  const base = amountWithTransition(vehicle, includeTransition);
  const selected: BenefitId[] = vehicle.vehicleType === 'passenger'
    ? [...(profile.children ? ['children' as const] : []), ...(profile.youth ? ['youth' as const] : []), ...(profile.taxi ? ['taxi' as const] : [])]
    : [...(profile.smallBusiness ? ['smallBusiness' as const] : []), ...(profile.delivery ? ['delivery' as const] : [])];
  const policy = bundle?.policy;
  const timestamp = Date.parse(policy?.checkedAt ?? '');
  const policyFresh = policy?.sourceStatus === 'live' && policy.year === year &&
    Number.isFinite(timestamp) && now - timestamp <= FRESH_FOR && timestamp <= now + 5 * 60_000 &&
    policy.sharedFunding && policy.additivePercentages && policy.fixedAfterPercentages;
  const lines: BenefitLine[] = selected.map(id => {
    const rule = policy?.rules.find(r => r.id === id);
    const unverified = (detail: string): BenefitLine => ({ id, label: LABELS[id], amount: null, state: 'unverified', detail });
    if (!policyFresh || !rule) return unverified('최신 공식 지침 확인 필요');
    if (id === 'youth' && includeTransition) return unverified('생애 최초 구매와 기존 차량 전환은 동시 적용할 수 없어요');
    const applies = applicability(vehicle, rule);
    if (applies === 'unknown') return unverified('이 차급의 추가지원 적용 여부는 공고 확인이 필요해요');
    if (applies === 'no') return { id, label: rule.label, amount: 0, state: 'not-applicable', detail: '해당 차종·차급에 적용되지 않아요' };
    if (base.total === null || vehicle.national === null || !Number.isFinite(vehicle.national)) return unverified('기본 보조금 원문 확인 필요');
    if (vehicle.national <= 0) return { id, label: rule.label, amount: 0, state: 'not-applicable', detail: '기본 국비 지원 대상 차량에 한해 계산해요' };
    let additionalWon: number;
    if (rule.kind === 'children') {
      const value = profile.children ? rule.childAmounts?.[profile.children] : undefined;
      if (value === undefined || !Number.isFinite(value) || value < 0) return unverified('자녀 수별 공식 금액 확인 필요');
      additionalWon = won(value);
    } else if (rule.kind === 'percent') {
      if (!Number.isFinite(rule.value) || rule.value < 0 || rule.value > 100) return unverified('공식 가산율 확인 필요');
      // Each percentage uses the original national amount, never another bonus.
      additionalWon = Math.round(won(vehicle.national) * rule.value / 100);
    } else {
      if (!Number.isFinite(rule.value) || rule.value < 0) return unverified('공식 추가액 확인 필요');
      additionalWon = won(rule.value);
    }
    return { id, label: rule.label, amount: money(additionalWon), state: 'estimated', detail: rule.requirement };
  });
  const unresolved = lines.some(line => line.state === 'unverified');
  const additional = money(lines.reduce((sum, line) => sum + (line.amount === null ? 0 : won(line.amount)), 0));
  const total = base.total === null || unresolved ? null : money(won(base.total) + won(additional));
  return {
    base, lines, additional: unresolved ? null : additional, total, policyFresh: Boolean(policyFresh),
    hasSelection: selected.length > 0,
    localReviewNeeded: selected.length > 0,
  };
}
