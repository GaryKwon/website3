export type BenefitId = 'children' | 'youth' | 'smallBusiness' | 'delivery' | 'taxi' | 'lowIncomePassenger' | 'lowIncomeCargo' | 'farmer';
export type BenefitProfile = {
  children: 0 | 2 | 3 | 4;
  youth: boolean;
  smallBusiness: boolean;
  delivery: boolean;
  taxi: boolean;
  lowIncome: boolean;
  farmer: boolean;
};
export const EMPTY_BENEFIT_PROFILE: BenefitProfile = {
  children: 0, youth: false, smallBusiness: false, delivery: false, taxi: false, lowIncome: false, farmer: false,
};
export type BenefitScope = 'passenger-standard' | 'passenger-all' | 'cargo-small-light-micro';
export type BenefitRule = {
  id: BenefitId;
  label: string;
  kind: 'fixed' | 'percent' | 'children';
  value: number;
  childAmounts?: { 2: number; 3: number; 4: number };
  scope: BenefitScope;
  requirement: string;
  clause: string;
};
export type BenefitReviewRule = {
  id: 'oldEv' | 'lease' | 'microProject';
  label: string;
  amountLabel: string;
  requirement: string;
  clause: string;
  scopes: ('passenger-standard' | 'passenger-micro' | 'cargo-micro')[];
  expiresOn?: string;
};
export type BenefitPolicy = {
  year: number;
  revision: string;
  checkedAt: string | null;
  sourceUrl: string;
  documentUrl: string | null;
  fingerprint: string | null;
  sourceStatus: 'live' | 'unavailable';
  rules: BenefitRule[];
  reviewRules?: BenefitReviewRule[];
  sharedFunding: boolean;
  additivePercentages: boolean;
  fixedAfterPercentages: boolean;
  message?: string;
};
export type LocalBenefitNotice = {
  code: string;
  label: string;
  downloadUrl: string;
};
export type LocalBenefitInfo = {
  regionId: string;
  vehicleType: 'passenger' | 'cargo';
  year: number;
  checkedAt: string | null;
  sourceStatus: 'live' | 'unavailable';
  sourceUrl: string;
  noticeText: string;
  notices: LocalBenefitNotice[];
  signals: { id: string; label: string; excerpt: string; kind?: 'restriction' | 'deduction' | 'closure' | 'program' | 'benefit' | 'general' }[];
  // Free-text notices are evidence to review, never an automatic monetary award.
  monetaryVerification: 'local-notice-required';
};
export type BenefitBundle = { policy: BenefitPolicy; local: LocalBenefitInfo };
export type BenefitLine = {
  id: BenefitId;
  label: string;
  amount: number | null;
  state: 'estimated' | 'not-applicable' | 'unverified';
  detail: string;
};
