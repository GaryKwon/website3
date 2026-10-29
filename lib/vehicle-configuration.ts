/** Display-only grouping. Subsidy amounts always belong to the exact official model ID. */
export function vehicleFamily(name: string): string {
  const patterns: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
    [/아이오닉\s?([569])/i,m=>`아이오닉${m[1]}`],
    [/\bEV([3-9])\b/i,m=>`EV${m[1]}`],
    [/더뉴\s?EV([3-9])/i,m=>`EV${m[1]}`],
    [/\bModel\s?([3YXS])\b/i,m=>`Model ${m[1].toUpperCase()}`],
    [/\bGV(60|70)\b/i,m=>`GV${m[1]}`],
    [/\bG80\b/i,'ELECTRIFIED G80'],
    [/토레스\s?EVX/i,'토레스 EVX'],
    [/MUSSO\s?EV/i,'MUSSO EV'],
    [/코나\s?일렉트릭/i,'코나 일렉트릭'],
    [/캐스퍼\s?일렉트릭/i,'캐스퍼 일렉트릭'],
    [/\bPV5\b/i,'PV5'],
    [/봉고/i,'봉고 전기차'],
    [/포터[Ⅱ2]?/i,'포터Ⅱ 일렉트릭'],
    [/스타리아/i,'스타리아 일렉트릭'],
    [/\bST1\b/i,'ST1'],
    [/\bNiro\b|니로/i,'Niro EV'],
    [/레이\s?EV/i,'레이 EV'],
    [/MINI.*Aceman/i,'MINI Aceman'],
    [/MINI.*Countryman/i,'MINI Countryman'],
    [/MINI.*(?:Cooper|JCW E)/i,'MINI Cooper'],
    [/\b(i[Xx]?[1-9])\b/,m=>m[1]],
    [/\b(ID\.[45])\b/i,m=>m[1].toUpperCase()],
    [/\b(Q[46])\b/i,m=>`${m[1].toUpperCase()} e-tron`],
    [/\b(EX30CC|EX30|ES90)\b/i,m=>m[1].toUpperCase()],
    [/\bPolestar\s([34])\b/i,m=>`Polestar ${m[1]}`],
    [/\b(EQA|EQB)\b/i,m=>m[1].toUpperCase()],
    [/\bBYD\s(ATTO 3|DOLPHIN|SEALION 7|SEAL)\b/i,m=>`BYD ${m[1].toUpperCase()}`],
  ];
  for (const [pattern, display] of patterns) {
    const match = name.match(pattern);
    if (match) return typeof display === 'function' ? display(match) : display;
  }
  return name;
}

export function vehicleConfiguration(name: string): { drive: string | null; wheel: string | null; trim: string | null } {
  const drive = name.match(/\b(2WD|4WD|AWD|RWD|FWD|ALL4|4MATIC)\b/i)?.[1]?.toUpperCase() ?? null;
  const wheel = name.match(/(\d{2})\s*인치/i)?.[1];
  const trims = name.match(/롱레인지|스탠다드|항속형|기본형|Long Range|Standard Range|Performance|N라인|GTL|\bGT\b|크로스|빌트인\s*캠\s*미적용/gi);
  return {drive,wheel:wheel ? `${wheel}인치` : null,trim:trims?.join(' · ') ?? null};
}

export function amountWithTransition(record: {
  national: number | null; local: number | null; total: number | null;
  transitionNational: number | null; transitionLocal: number | null;
}, includeTransition: boolean): { national: number | null; local: number | null; total: number | null; transition: number | null } {
  const valid = (n: number | null) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const won = (n: number) => Math.round(n * 10_000);
  const sum = (...amounts: number[]) => amounts.reduce((total,n) => total+won(n),0)/10_000;
  const baseValid = valid(record.national) && valid(record.local) && valid(record.total)
    && won(record.national!)+won(record.local!) === won(record.total!);
  if (!includeTransition) return {national:record.national,local:record.local,total:baseValid?record.total:null,transition:0};
  const transitionValid = valid(record.transitionNational) && valid(record.transitionLocal);
  return {
    national:valid(record.national) && valid(record.transitionNational) ? sum(record.national!,record.transitionNational!) : null,
    local:valid(record.local) && valid(record.transitionLocal) ? sum(record.local!,record.transitionLocal!) : null,
    total:baseValid && transitionValid ? sum(record.total!,record.transitionNational!,record.transitionLocal!) : null,
    transition:transitionValid ? sum(record.transitionNational!,record.transitionLocal!) : null,
  };
}
