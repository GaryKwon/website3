"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { amountWithTransition } from "@/lib/vehicle-configuration";
import { apiUrl } from "@/lib/api-url";
import { calculateAdditionalBenefits } from "@/lib/benefit-calculation";
import { EMPTY_BENEFIT_PROFILE, type BenefitBundle, type BenefitProfile } from "@/lib/benefit-types";
import { AdditionalBenefits, AdditionalBenefitBreakdown, LocalBenefitReview, BenefitPolicyVerification, BenefitCoverageSummary } from "@/components/additional-benefits";

type Region = { id: string; province: string; name: string; aliases: string[]; children?: string[] };
type Vehicle = {
  id: string; manufacturer: string; modelName: string; family: string; vehicleType: "passenger" | "cargo";
  category: string; categoryCode: string; national: number | null; local: number | null; total: number | null;
  transitionNational: number | null; transitionLocal: number | null; discontinued: boolean;
  specs: { battery: string | null; range: string | null; seats: string | null };
  configuration: { drive: string | null; wheel: string | null; trim: string | null };
  checks: { id: string; label: string; passed: boolean }[];
};
type Data = { benefits?: BenefitBundle; records: Vehicle[]; regionId: string; year: number; checkedAt: string | null; sourceUrl: string; sourceStatus: "live" | "cached" | "unavailable"; applicationStatus?: "open" | "closed" | "unknown"; statusReason?: string | null; remaining?: number | null; availability?: {announced:number|null;received:number|null;selected:number|null;delivered:number|null;selectionRemaining:number|null;deliveryRemaining:number|null;checkedAt:string;checks:{id:string;label:string;passed:boolean}[]}|null; statusSourceStatus?: "live"|"cached"|"unavailable"; statusCheckedAt?:string|null; message?: string };
const OFFICIAL = "https://ev.or.kr/nportal/buySupprt/initPsLocalCarPirceAction.do";
const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(n);
const date = (s: string | null | undefined) => s && Number.isFinite(Date.parse(s)) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s)) : "확인 시각 없음";
const FALLBACK: Region[] = [
  { id: "1100", name: "서울특별시", province: "서울특별시", aliases: ["서울", "서울시"] },
  { id: "2600", name: "부산광역시", province: "부산광역시", aliases: ["부산"] },
  { id: "5000", name: "제주특별자치도", province: "제주특별자치도", aliases: ["제주", "제주시", "서귀포시"] },
];
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    search: <><circle cx="10.6" cy="10.6" r="6.5" /><path d="m15.5 15.5 4.8 4.8" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    left: <path d="M19 12H5m6-6-6 6 6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pin: <><path d="M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    shield: <><path d="m12 3 8 3v5c0 5-8 10-8 10s-8-5-8-10V6z" /><path d="m8 12 3 3 5-5" /></>,
    northeast: <path d="m6 18 12-12M6 6h12v12" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    car: <><path d="m5 8 2-4h10l2 4M3 10l2-2h14l2 2v8H3zM5 18v3M19 18v3M3 13h18" /><path d="M6 16h1M17 16h1" /></>,
    truck: <><path d="M2 5h13v13H2zM15 10h4l3 4v4h-7" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /></>,
    battery: <><rect x="3" y="6" width="17" height="12" rx="3" /><path d="M23 10v4M7 10v4M11 10v4M15 10v4" /></>,
    range: <><path d="M6 21 9 3M18 21 15 3M12 4v3M12 11v3M12 18v3" /></>,
    seats: <><path d="M7 3v9a3 3 0 0 0 3 3h8M7 19h12M5 21v-5M18 15v6M11 3v8h7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.info}</svg>;
}

export default function Home() {
  const [regions, setRegions] = useState<Region[]>(FALLBACK);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const [locationVersion, setLocationVersion] = useState(0);
  const [region, setRegion] = useState<Region | null>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [vehicleType, setVehicleType] = useState<"passenger" | "cargo">("passenger");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [maker, setMaker] = useState("");
  const [family, setFamily] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [drive, setDrive] = useState("");
  const [wheel, setWheel] = useState("");
  const [transition, setTransition] = useState(false);
  const [benefitProfile, setBenefitProfile] = useState<BenefitProfile>({ ...EMPTY_BENEFIT_PROFILE });
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [allModels, setAllModels] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const lastFetch = useRef(0);
  const activeRequest = useRef<{ id: number; key: string; controller: AbortController; timeout: number } | null>(null);
  const pendingModel = useRef<{ key: string; id: string } | null>(null);
  const selectedModel = useRef("");
  const blurTimeout = useRef<number | null>(null);
  const closeModal = useRef<HTMLButtonElement>(null);
  const regionId = region?.id || "";
  const isProvince = Boolean(region?.children?.length) || Boolean(region?.id.startsWith("province:"));
  const clearBlurTimeout = useCallback(() => {
    if (blurTimeout.current !== null) window.clearTimeout(blurTimeout.current);
    blurTimeout.current = null;
  }, []);
  const cancelRequest = useCallback(() => {
    const active = activeRequest.current;
    activeRequest.current = null;
    requestId.current++;
    if (active) { window.clearTimeout(active.timeout); active.controller.abort(); }
  }, []);
  const resetVehicle = useCallback(() => {
    pendingModel.current = null;
    selectedModel.current = "";
    setMaker(""); setFamily(""); setModelQuery(""); setSelectedId(""); setDrive(""); setWheel(""); setTransition(false); setAllModels(false); setBenefitProfile({ ...EMPTY_BENEFIT_PROFILE });
  }, []);
  useEffect(() => { selectedModel.current = selectedId; }, [selectedId]);
  useEffect(() => () => { clearBlurTimeout(); cancelRequest(); }, [clearBlurTimeout, cancelRequest]);
  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    fetch(apiUrl("/api/regions"), { cache: "no-store", signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error();
      return await r.json() as { regions: Region[] };
    }).then(d => {
      if (!controller.signal.aborted && Array.isArray(d.regions) && d.regions.length) setRegions(d.regions);
    }).catch(() => {}).finally(() => {
      window.clearTimeout(timeout);
      if (mounted) setRegionsLoaded(true);
    });
    return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
  }, []);

  const restoreLocation = useCallback(() => {
    const params = new URL(window.location.href).searchParams;
    const requestedRegion = params.getAll("region").length === 1 ? params.get("region") || "" : "";
    const found = requestedRegion.length <= 80 ? regions.find(r => r.id === requestedRegion) : undefined;
    // Wait for the complete authority list before discarding an otherwise unknown URL.
    if (requestedRegion && !found && !regionsLoaded) return;
    const type = params.getAll("type").length === 1 && params.get("type") === "cargo" ? "cargo" : "passenger";
    const model = params.getAll("model").length === 1 ? params.get("model") || "" : "";
    cancelRequest(); clearBlurTimeout(); resetVehicle();
    setData(null); setLoading(Boolean(found && !found.children?.length && !found.id.startsWith("province:"))); setVerificationOpen(false); setFocused(false); setHighlight(0);
    setRegion(found || null); setQuery(found?.name || ""); setVehicleType(found ? type : "passenger");
    if (found && !found.children?.length && !found.id.startsWith("province:") && model.length <= 160 && !/[\u0000-\u001f\u007f]/.test(model) && model) {
      pendingModel.current = { key: `${found.id}:${type}`, id: model };
    }
    setLocationReady(true);
    setLocationVersion(version => version + 1);
  }, [regions, regionsLoaded, cancelRequest, clearBlurTimeout, resetVehicle]);
  useEffect(() => {
    if (!locationReady) restoreLocation();
    const onPopState = () => restoreLocation();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [restoreLocation, locationReady]);
  useEffect(() => {
    if (!locationReady) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("region"); url.searchParams.delete("type"); url.searchParams.delete("model");
    if (regionId) {
      url.searchParams.set("region", regionId);
      url.searchParams.set("type", vehicleType);
      const restoring = pendingModel.current;
      const model = selectedId || (restoring?.key === `${regionId}:${vehicleType}` ? restoring.id : "");
      if (model && !isProvince) url.searchParams.set("model", model);
    }
    if (!regionId) url.hash = "";
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [locationReady, locationVersion, regionId, vehicleType, selectedId, isProvince, data]);

  const refresh = useCallback(async (initial = false) => {
    if (!locationReady || !regionId || isProvince || (!initial && document.visibilityState === "hidden")) return;
    const key = `${regionId}:${vehicleType}`;
    if (activeRequest.current?.key === key) return;
    if (!initial && Date.now() - lastFetch.current < 45_000) return;
    cancelRequest();
    lastFetch.current = Date.now();
    const id = ++requestId.current;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 40_000);
    activeRequest.current = { id, key, controller, timeout };
    setRefreshing(true);
    if (initial) { setData(null); setLoading(true); }
    const stale = (old: Data): Data => ({ ...old, sourceStatus: "cached", applicationStatus: "unknown", statusReason: null, remaining: null, availability: null, statusSourceStatus: "unavailable", benefits: old.benefits ? { policy: { ...old.benefits.policy, sourceStatus: "unavailable" }, local: { ...old.benefits.local, sourceStatus: "unavailable" } } : undefined, records: old.records.map(r => ({ ...r, checks: r.checks.map(c => c.id === "freshness" ? { ...c, passed: false } : c) })) });
    try {
      const response = await fetch(apiUrl(`/api/vehicles?region=${encodeURIComponent(regionId)}&type=${vehicleType}`), { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error();
      const next = await response.json() as Data;
      if (!Array.isArray(next.records) || next.regionId !== regionId || next.records.some(r => r.vehicleType !== vehicleType)) throw new Error();
      if (id !== requestId.current || controller.signal.aborted) return;
      setData(old => next.sourceStatus === "unavailable" && old?.regionId === regionId ? stale(old) : next);
      const restoring = pendingModel.current?.key === key ? pendingModel.current : null;
      const targetId = restoring?.id || selectedModel.current;
      if (targetId && (next.records.length || next.sourceStatus === "live")) {
        const restored = next.records.find(r => r.id === targetId);
        pendingModel.current = null;
        if (restored) {
          selectedModel.current = restored.id;
          setSelectedId(restored.id); setMaker(restored.manufacturer); setFamily(`${restored.manufacturer}|${restored.family || restored.modelName}`);
          setDrive(restored.configuration?.drive || ""); setWheel(restored.configuration?.wheel || "");
          if (restored.transitionNational === null || restored.transitionLocal === null) setTransition(false);
        } else resetVehicle();
      }
    } catch {
      if (id !== requestId.current || (controller.signal.aborted && !timedOut)) return;
      setData(old => old?.regionId === regionId ? stale(old) : { records: [], regionId, year: Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date())), checkedAt: null, sourceUrl: OFFICIAL, sourceStatus: "unavailable", applicationStatus: "unknown", statusReason: null, remaining: null });
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current?.id === id) activeRequest.current = null;
      if (id === requestId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [locationReady, locationVersion, regionId, isProvince, vehicleType, cancelRequest, resetVehicle]);
  useEffect(() => {
    if (!locationReady || !regionId || isProvince) return;
    void refresh(true);
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5 * 60_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible);
      cancelRequest();
    };
  }, [locationReady, regionId, isProvince, refresh, cancelRequest]);
  useEffect(() => {
    if (!verificationOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeModal.current?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVerificationOpen(false);
      if (e.key === "Tab") {
        const controls = document.querySelectorAll<HTMLElement>('#verification-dialog button, #verification-dialog a[href]');
        if (!controls.length) return;
        if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls[controls.length-1].focus(); }
        else if (!e.shiftKey && document.activeElement === controls[controls.length-1]) { e.preventDefault(); controls[0].focus(); }
      }
    };
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    document.addEventListener("keydown", listener);
    return () => { document.removeEventListener("keydown", listener); document.body.style.overflow = previous; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [verificationOpen]);

  const suggestions = useMemo(() => {
    const needle = normalize(query);
    return regions.filter(r => !needle || [r.name, `${r.province}${r.name}`, ...r.aliases].some(v => normalize(v).includes(needle))).sort((a,b) => Number([b.name,...b.aliases].some(v=>normalize(v)===needle))-Number([a.name,...a.aliases].some(v=>normalize(v)===needle))).slice(0, 7);
  }, [regions, query]);
  const chooseRegion = (r: Region) => { window.scrollTo({top:0,behavior:"instant"}); cancelRequest(); resetVehicle(); setData(null); setLoading(!r.children?.length && !r.id.startsWith("province:")); setRegion(r); setQuery(r.name); setFocused(false); setHighlight(0); input.current?.blur(); clearBlurTimeout(); };
  const goHome = () => { window.scrollTo({top:0,behavior:"instant"}); cancelRequest(); clearBlurTimeout(); setRegion(null); setQuery(""); setFocused(false); setData(null); setLoading(false); setVerificationOpen(false); resetVehicle(); setVehicleType("passenger"); };
  const availableRecords = useMemo(() => data?.records || [], [data]);
  const manufacturers = useMemo(() => [...new Set(availableRecords.map(r => r.manufacturer))], [availableRecords]);
  const makerRecords = useMemo(() => availableRecords.filter(r => !maker || r.manufacturer === maker), [availableRecords, maker]);
  const families = useMemo(() => {
    const groups = new Map<string, Vehicle[]>();
    for (const r of makerRecords) { const key = `${r.manufacturer}|${r.family || r.modelName}`; groups.set(key, [...(groups.get(key) || []), r]); }
    return [...groups].map(([key, records]) => ({ key, name: records[0].family || records[0].modelName, manufacturer: records[0].manufacturer, records }));
  }, [makerRecords]);
  const visibleFamilies = families.filter(f => normalize(`${f.manufacturer}${f.name}`).includes(normalize(modelQuery)));
  const selectedFamily = families.find(f => f.key === family);
  const variants = selectedFamily?.records || [];
  const filteredVariants = variants.filter(r => (!drive || r.configuration?.drive === drive) && (!wheel || r.configuration?.wheel === wheel));
  const selected = availableRecords.find(r => r.id === selectedId) ?? null;
  const drives = [...new Set(variants.map(r => r.configuration?.drive).filter((v): v is string => Boolean(v)))];
  const wheels = [...new Set(variants.filter(r => !drive || r.configuration?.drive === drive).map(r => r.configuration?.wheel).filter((v): v is string => Boolean(v)))];
  const chooseVariant = (r: Vehicle) => { setSelectedId(r.id); setDrive(r.configuration?.drive || ""); setWheel(r.configuration?.wheel || ""); setTransition(false); };
  const chooseFamily = (key: string) => { setFamily(key); setTransition(false); const first = families.find(f => f.key === key)?.records[0]; setSelectedId(first?.id || ""); setDrive(first?.configuration?.drive || ""); setWheel(first?.configuration?.wheel || ""); };
  const chooseDrive = (value: string) => { const list = variants.filter(r => !value || r.configuration?.drive === value); const next = list.find(r => r.configuration?.wheel === wheel) || list[0]; if (next) { setSelectedId(next.id); setWheel(next.configuration?.wheel || ""); } setDrive(value); setTransition(false); };
  const chooseWheel = (value: string) => { const next = variants.find(r => (!drive || r.configuration?.drive === drive) && (!value || r.configuration?.wheel === value)); if (next) setSelectedId(next.id); setWheel(value); setTransition(false); };
  const transitionOffered = selected && selected.transitionNational !== null && selected.transitionLocal !== null && selected.transitionNational + selected.transitionLocal > 0;
  const currentYear = data?.year || Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
  const benefitCalculation = selected ? calculateAdditionalBenefits(selected, transition, benefitProfile, data?.sourceStatus === "live" ? data.benefits : undefined, currentYear) : null;
  const { national, local } = benefitCalculation?.base ?? { national:null, local:null };
  const total = benefitCalculation?.total ?? null;
  const verified = selected && selected.checks.length > 0 && selected.checks.every(c => c.passed) && data?.sourceStatus === "live";
  const updateBenefitProfile = (profile: BenefitProfile) => { if (profile.youth) setTransition(false); setBenefitProfile(profile); };
  const updateTransition = (include: boolean) => { setTransition(include); if (include) setBenefitProfile(profile => ({ ...profile, youth: false })); };
  const children = regions.filter(r => region?.children?.includes(r.id));

  const searchBox = <div className={`region-search ${focused ? "has-focus" : ""}`}><form role="search" onSubmit={e => { e.preventDefault(); if (suggestions[highlight]) chooseRegion(suggestions[highlight]); }}><span className="search-icon"><Icon name="search" size={23} /></span><input ref={input} value={query} type="search" placeholder="지역을 검색하세요" aria-label="시·군·구·도 검색" role="combobox" aria-expanded={focused && suggestions.length>0} aria-controls="region-options" aria-autocomplete="list" aria-activedescendant={focused && suggestions[highlight] ? `region-option-${highlight}` : undefined} autoComplete="off" onFocus={() => { clearBlurTimeout(); setFocused(true); }} onBlur={() => { clearBlurTimeout(); blurTimeout.current = window.setTimeout(() => { blurTimeout.current = null; setFocused(false); }, 150); }} onChange={e => { setQuery(e.target.value); setHighlight(0); setFocused(true); }} onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setFocused(true); setHighlight(v => Math.min(v+1,suggestions.length-1)); } if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(v => Math.max(0,v-1)); } if (e.key === "Escape") { setFocused(false); input.current?.blur(); } }} />{query && <button className="clear-search" type="button" aria-label="검색어 지우기" onClick={() => { setQuery(""); setFocused(true); setHighlight(0); input.current?.focus(); }}><Icon name="close" size={16} /></button>}<button className="search-go" aria-label="지역 검색" type="submit"><Icon name="arrow" size={21} /></button></form>{focused && suggestions.length > 0 && <div id="region-options" className="search-suggestions" role="listbox" aria-label="지역 선택">{suggestions.map((r,i) => <button key={r.id} id={`region-option-${i}`} role="option" aria-selected={i===highlight} className={i===highlight ? "active" : ""} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setHighlight(i)} onClick={() => chooseRegion(r)}><Icon name="pin" size={17}/><span>{r.name}<small>{r.name !== r.province ? r.province : r.children?.length ? "시·군 선택" : ""}</small></span><Icon name="arrow" size={15}/></button>)}</div>}{focused && query && suggestions.length===0 && <div className="search-suggestions no-suggestions">일치하는 지역이 없어요.</div>}</div>;

  return <div className={`app-shell ${region ? "has-region" : "landing"}`}><div className="gradient-scene" aria-hidden="true"><i/><i/><i/><i/><div className="grain"/></div>{!region ? <main className="landing-center" aria-label="전기차 보조금 지역 검색">{searchBox}</main> : <main className="result-shell"><header className="result-header"><button className="back-home" aria-label="시작 화면으로" onClick={goHome}><Icon name="left" size={21}/></button>{searchBox}<div className="vehicle-switch" role="group" aria-label="차종"><button aria-pressed={vehicleType==="passenger"} className={vehicleType==="passenger" ? "active" : ""} onClick={() => { if(vehicleType!=="passenger") {cancelRequest();setData(null);setLoading(!isProvince);setVehicleType("passenger");resetVehicle();} }}><Icon name="car" size={17}/><span>승용</span></button><button aria-pressed={vehicleType==="cargo"} className={vehicleType==="cargo" ? "active" : ""} onClick={() => { if(vehicleType!=="cargo") {cancelRequest();setData(null);setLoading(!isProvince);setVehicleType("cargo");resetVehicle();} }}><Icon name="truck" size={18}/><span>화물</span></button></div></header>
    {isProvince ? <section className="glass province-panel"><span className="section-eyebrow">{region.name}</span><h1>시·군을 선택하세요</h1><div className="city-grid">{children.map(city => <button key={city.id} onClick={() => chooseRegion(city)}>{city.name}<Icon name="arrow" size={16}/></button>)}</div>{children.length===0 && <p className="quiet-message">지역 이름을 조금 더 자세히 검색해 주세요.</p>}</section> : <><div className="result-title"><div><span className="section-eyebrow">{currentYear} 전기차 구매보조금</span><h1>{region.name}<span>에서 받을 수 있는 금액</span></h1></div><button className={`source-state ${data?.sourceStatus!=="live" ? "muted" : ""}`} onClick={() => setVerificationOpen(true)}><span/>{loading || refreshing ? "기본 금액 확인 중" : data?.sourceStatus==="live" ? "기본 금액 원문" : data?.sourceStatus==="cached" ? "이전 기본 금액" : "연결 확인 필요"}<Icon name="info" size={13}/></button></div>
    <div className="regional-availability" aria-live="polite"><div><span>선정 잔여</span><b>{money(data?.availability?.selectionRemaining)}<small>대</small></b></div><div><span>출고 잔여</span><b>{money(data?.availability?.deliveryRemaining)}<small>대</small></b></div><span className="availability-caption">{loading ? "공식 현황 확인 중" : data?.statusSourceStatus !== "live" ? "현황 확인 필요" : data?.applicationStatus === "closed" ? "현재 접수 마감" : "신청 확정과는 달라요"}</span></div><div className="calculator-grid"><section className="glass configuration-panel" aria-label="차량 선택"><div className="panel-heading"><span className="step-number">01</span><h2>차량 선택</h2>{selectedFamily && <button className="text-button" onClick={() => {setFamily("");setSelectedId("");setDrive("");setWheel("");}}>다른 차량<Icon name="arrow" size={13}/></button>}</div><div className="control-grid"><label className="field"><span>제조사</span><div className="select-wrap"><select aria-label="제조사" value={maker} onChange={e => {setMaker(e.target.value);setFamily("");setSelectedId("");setDrive("");setWheel("");setTransition(false);}} disabled={loading || !manufacturers.length}><option value="">전체 제조사</option>{manufacturers.map(m => <option key={m} value={m}>{m}</option>)}</select><Icon name="chevron" size={15}/></div></label><label className="field"><span>모델</span><div className="select-wrap"><select aria-label="모델" value={family} onChange={e => chooseFamily(e.target.value)} disabled={loading || !families.length}><option value="">모델을 선택하세요</option>{families.map(f => <option key={f.key} value={f.key}>{!maker ? `${f.manufacturer} · ` : ""}{f.name}</option>)}</select><Icon name="chevron" size={15}/></div></label></div>
    {loading ? <div className="vehicle-loading" role="status"><span className="loading-orbit"/><p>공식 차량 정보를 확인하고 있어요</p></div> : !availableRecords.length ? <div className="vehicle-empty"><Icon name="car" size={32}/><h3>{data?.sourceStatus==="unavailable" ? "공식 정보를 불러올 수 없어요" : "등록된 지원 차량이 없어요"}</h3><p>자동으로 다시 확인합니다.</p><a href={data?.sourceUrl || OFFICIAL} target="_blank" rel="noopener noreferrer">공식 원문<Icon name="northeast" size={14}/></a></div> : !selectedFamily ? <><div className="model-search"><Icon name="search" size={16}/><input aria-label="차량 이름 검색" placeholder="차량 이름으로 찾기" value={modelQuery} onChange={e => setModelQuery(e.target.value)}/></div><div className="family-grid">{visibleFamilies.slice(0,allModels ? undefined : 8).map(f => {const amounts=f.records.map(r=>amountWithTransition(r,false).total).filter((n):n is number=>n!=null && Number.isFinite(n));const min=amounts.length ? Math.min(...amounts):null;const max=amounts.length ? Math.max(...amounts):null;return <button key={f.key} className="family-card" onClick={() => chooseFamily(f.key)}><span className="family-maker">{f.manufacturer}</span><b>{f.name}</b><span className="family-price">{min==null ? "금액 확인 필요" : `${money(min)}${min!==max ? `–${money(max)}` : ""}`}<small>{min!=null ? "만원" : ""}</small></span><Icon name="northeast" size={15}/></button>;})}</div>{visibleFamilies.length===0 && <p className="quiet-message">일치하는 차량이 없어요.</p>}{visibleFamilies.length>8 && !allModels && <button className="more-models" onClick={() => setAllModels(true)}>모델 더 보기<Icon name="chevron" size={15}/></button>}</> : <div className="variant-section"><div className="subsection-heading"><span className="step-number">02</span><h2>제원·옵션</h2></div>{drives.length>1 && <div className="facet-group"><span>구동 방식</span><div>{drives.map(d => <button key={d} aria-pressed={drive===d} className={drive===d ? "selected" : ""} onClick={() => chooseDrive(d)}>{d}</button>)}</div></div>}{wheels.length>1 && <div className="facet-group"><span>휠</span><div>{wheels.map(w => <button key={w} aria-pressed={wheel===w} className={wheel===w ? "selected" : ""} onClick={() => chooseWheel(w)}>{w}</button>)}</div></div>}<label className="field variant-field"><span>세부 모델</span><div className="select-wrap"><select aria-label="세부 모델·옵션" value={selectedId} onChange={e => {const next=variants.find(r=>r.id===e.target.value);if(next) chooseVariant(next);}}>{(filteredVariants.length ? filteredVariants : variants).map(v=><option key={v.id} value={v.id}>{v.discontinued ? "(단종) " : ""}{v.modelName}</option>)}</select><Icon name="chevron" size={15}/></div></label>{selected && <><div className="specs-row">{[{icon:"battery",label:"배터리",value:selected.specs?.battery},{icon:"range",label:"1회 충전 주행거리",value:selected.specs?.range},{icon:"seats",label:"승차 인원",value:selected.specs?.seats}].map(s=><div key={s.label}><Icon name={s.icon} size={19}/><span>{s.label}</span><b>{s.value || "미제공"}</b></div>)}</div><p className="option-note"><Icon name="info" size={13}/>보조금에 등록된 세부 모델 기준</p>{transitionOffered && <label className="transition-option"><input type="checkbox" checked={transition} onChange={e=>updateTransition(e.target.checked)}/><span className="custom-check">{transition && <Icon name="check" size={13}/>}</span><span>전환지원금 대상<small>3년 이상 내연기관차 처분 등 요건 충족 시</small></span><span className="transition-plus">+{money(amountWithTransition(selected,true).transition)}<small>만원</small></span></label>}</>}{selected && benefitCalculation && <><AdditionalBenefits vehicleType={vehicleType} category={selected.category} categoryCode={selected.categoryCode} profile={benefitProfile} onChange={updateBenefitProfile} bundle={data?.benefits} calculation={benefitCalculation} transition={transition}/><LocalBenefitReview bundle={data?.benefits} profile={benefitProfile} year={currentYear} regionName={region.name}/></>}</div>}
    </section><aside id="amount-detail" className={`glass amount-panel ${selected ? "has-selection" : ""}`} aria-label="예상 보조금" aria-live="polite"><div className="amount-topline"><span>예상 보조금</span><span className="year-tag">{currentYear}</span></div>{selected ? <><div className="amount-model"><span>{selected.manufacturer}</span><h2>{selected.family || selected.modelName}</h2><p>{selected.discontinued ? "(단종) " : ""}{selected.modelName}</p></div>{selected.discontinued && <div className="application-closed">공식 단종 표기 모델 · 접수 가능 여부 확인</div>}<div className="amount-total"><b>{money(total)}</b><span>만원</span></div>{benefitCalculation && benefitCalculation.pendingCount > 0 && <div className="benefit-pending-total" role="status"><p>추가 지원 {benefitCalculation.pendingCount}건 확인 필요</p>{benefitCalculation.knownTotal !== null && <span>현재 계산된 항목 <b>{money(benefitCalculation.knownTotal)}만원</b></span>}<small>미확인 추가금은 합계에 넣지 않았어요.</small></div>}{data?.applicationStatus === "closed" && <div className="application-closed" title={data.statusReason || undefined}><span/>현재 접수 마감</div>}<div className="amount-breakdown"><div><span><i className="national-dot"/>{benefitCalculation?.hasSelection ? transition ? "국비·전환" : "기본 국비" : "국비"}</span><b>{money(national)}<small>만원</small></b></div><span className="amount-plus">+</span><div><span><i className="local-dot"/>{benefitCalculation?.hasSelection ? transition ? "지방비·전환" : "기본 지방비" : "지방비"}</span><b>{money(local)}<small>만원</small></b></div></div>{benefitCalculation && <AdditionalBenefitBreakdown calculation={benefitCalculation}/>}{transition && <div className="transition-included"><Icon name="check" size={13}/>전환지원금 포함</div>}{benefitCalculation && <BenefitCoverageSummary bundle={data?.benefits} calculation={benefitCalculation} checkedAt={data?.checkedAt} baseVerified={Boolean(verified)} sourceStatus={data?.sourceStatus} refreshing={refreshing} year={currentYear}/>}<div className="amount-bottom"><button className={`verification-button ${verified ? "verified" : ""}`} onClick={()=>setVerificationOpen(true)}><Icon name={verified ? "shield" : "info"} size={15}/>{verified ? "기본 금액 대조 내역" : data?.sourceStatus==="cached" ? "이전 확인 정보" : selected.checks.some(c=>c.id==="national-crosscheck"&&!c.passed) ? "원문 간 금액 차이" : "확인 내역"}<Icon name="arrow" size={13}/></button><p>{benefitCalculation?.hasSelection ? "선택한 자격 충족 시 예상액 · 지역 별도 지원 미포함" : "기본 보조금 기준 · 내 조건을 선택하면 추가금 반영"}</p></div></> : <div className="amount-placeholder"><div className="empty-car"><Icon name={vehicleType==="passenger" ? "car" : "truck"} size={51}/></div><span className="placeholder-amount">—<small>만원</small></span><p>차량을 선택하면<br/>보조금이 바로 보여요.</p></div>}</aside></div><div className="result-foot"><span>{data?.checkedAt ? `${data.sourceStatus==="cached" ? "마지막" : "최근"} 확인 ${date(data.checkedAt)} · 한국시간` : ""}</span><a href={data?.sourceUrl || OFFICIAL} target="_blank" rel="noopener noreferrer">무공해차 통합누리집<Icon name="northeast" size={13}/></a></div></>}
  </main>}{region && !isProvince && selected && <a className="glass mobile-total" href="#amount-detail" onClick={event => { event.preventDefault(); document.getElementById("amount-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-label={benefitCalculation && benefitCalculation.pendingCount > 0 ? `추가 지원 ${benefitCalculation.pendingCount}건 확인 필요, 상세 보기` : `예상 보조금 ${money(total)}만원 상세 보기`}><span>예상 보조금{benefitCalculation && benefitCalculation.pendingCount > 0 && <small className="mobile-pending">추가 {benefitCalculation.pendingCount}건 확인 필요</small>}{data?.applicationStatus === "closed" && <small className="mobile-closed">현재 접수 마감</small>}</span><b>{money(total)}<small>만원</small></b><Icon name="arrow" size={17}/></a>}{verificationOpen && <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setVerificationOpen(false);}}><section className="glass verification-modal" id="verification-dialog" role="dialog" aria-modal="true" aria-labelledby="verification-title"><div className="modal-title"><Icon name="shield" size={24}/><button ref={closeModal} aria-label="닫기" onClick={()=>setVerificationOpen(false)}><Icon name="close" size={20}/></button></div><h2 id="verification-title">기본·추가 지원 확인</h2><p>{date(data?.checkedAt)} · 한국시간</p>{selected?.checks.length ? <div className="check-list">{selected.checks.map(c=><div key={c.id}><span className={c.passed ? "passed" : "failed"}><Icon name={c.passed ? "check" : "info"} size={15}/></span><b>{c.label}</b><small>{c.passed ? "일치" : "확인 필요"}</small></div>)}</div> : <div className="verification-copy">공식 원문에서 지역·연도·모델과 국비·지방비 합계를 자동으로 대조합니다. 페이지를 열거나 새로고침할 때 공식 원문을 다시 조회하고, 화면이 열려 있는 동안 5분마다 확인합니다.</div>}{selected && benefitCalculation && <BenefitPolicyVerification bundle={data?.benefits} fresh={benefitCalculation.policyFresh}/>}{data?.availability && <div className="availability-verification"><h3>지자체 대수 현황</h3><p>{date(data.availability.checkedAt)} · 한국시간</p><dl>{[{label:"공고",value:data.availability.announced},{label:"접수",value:data.availability.received},{label:"선정",value:data.availability.selected},{label:"출고",value:data.availability.delivered},{label:"선정 잔여",value:data.availability.selectionRemaining},{label:"출고 잔여",value:data.availability.deliveryRemaining}].map(item=><div key={item.label}><dt>{item.label}</dt><dd>{money(item.value)}대</dd></div>)}</dl><p>선정 잔여 = 공고 − 선정 · 출고 잔여 = 공고 − 출고 (음수는 0)</p><p>접수 여부·예산 잔액과는 다르며, 민간 구매 기준입니다.</p></div>}{data?.sourceStatus!=="live" && <div className="verification-warning">{data?.sourceStatus==="cached" ? "최신 원문 조회에 실패해 이전 확인 금액을 표시하고 있어요." : "공식 원문 연결을 확인하고 있어요."}</div>}<p className="verification-note">휠·구동 방식 등 공식 등록 모델에 따른 금액입니다. 선택한 추가 지원은 확인된 공식 기준으로 계산하며, 지자체 별도 지원·제조사 선택품목은 포함하지 않습니다.</p><a className="modal-source" href={data?.sourceUrl || OFFICIAL} target="_blank" rel="noopener noreferrer">공식 원문 보기<Icon name="northeast" size={16}/></a></section></div>}</div>;
}
