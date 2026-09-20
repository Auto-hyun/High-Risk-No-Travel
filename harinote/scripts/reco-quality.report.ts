/**
 * 추천 품질 측정 실행 + 산출물 기록 — 실행: pnpm check:reco
 *
 * 산출물 (둘 다 git 추적):
 *   analysis/data/reco_quality_summary.csv    시나리오×모드 1행
 *   analysis/33_reco_quality_result.md        발표·문서 인용용 요약
 *
 * 결정적이다 — 같은 코드에서 두 번 돌리면 바이트 단위로 같은 파일이 나온다
 * (생성 시각을 쓰지 않는 이유). 안전 민감도 하네스와 같은 규약.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { MMR_LAMBDA } from "../src/lib/reco/alternatives";
import { runAll, SCENARIOS, type RecoMetrics } from "./reco-quality";

const ROOT = path.resolve(import.meta.dirname, "../..");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number, d = 2) => v.toFixed(d);

function engineRef(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    const dirty = execSync("git status --porcelain -- harinote/src/lib/reco", { cwd: ROOT })
      .toString()
      .trim();
    return dirty ? `${sha} (+ 미커밋 변경)` : sha;
  } catch {
    return "unknown";
  }
}

const results = runAll();
const by = (s: string, m: string) =>
  results.find((r) => r.scenario === s && r.mode === m)!;

// ── 콘솔 요약 ──
console.log(
  `시나리오 ${SCENARIOS.length}종 × 모드 2 · target ${results[0].targets}곳 · λ=${MMR_LAMBDA}\n`,
);
for (const s of SCENARIOS) {
  const b = by(s.key, "baseline");
  const m = by(s.key, "mmr");
  console.log(`── ${s.label} ──`);
  console.log(
    `  추천가능 ${pct(b.fillRate)} · 평균 ${num(b.meanCount)}건 · 제약위반 ${b.violations + m.violations}`,
  );
  console.log(
    `  전부 같은 분류   ${pct(b.monoCat3Rate).padStart(6)} → ${pct(m.monoCat3Rate).padStart(6)}`,
  );
  console.log(
    `  전부 같은 동네   ${pct(b.monoNeighborhoodRate).padStart(6)} → ${pct(m.monoNeighborhoodRate).padStart(6)}`,
  );
  console.log(
    `  ILD             ${num(b.ild, 3).padStart(6)} → ${num(m.ild, 3).padStart(6)}` +
      `   쌍평균거리 ${num(b.meanPairKm, 1)}km → ${num(m.meanPairKm, 1)}km`,
  );
  console.log(
    `  점수 개선폭     ${num(b.meanGain, 1).padStart(6)} → ${num(m.meanGain, 1).padStart(6)}` +
      `   (다양성의 대가)\n`,
  );
}

// ── CSV ──
const csvHeader =
  "scenario,mode,targets,fill_rate,mean_count,mean_gain,mean_distinct_cat3," +
  "mean_pair_km,ild,mono_cat3_rate,mono_neighborhood_rate,coverage,violations";
const csvRow = (r: RecoMetrics) =>
  [
    r.scenario, r.mode, r.targets,
    r.fillRate.toFixed(4), r.meanCount.toFixed(3), r.meanGain.toFixed(2),
    r.meanDistinctCat3.toFixed(3), r.meanPairKm.toFixed(2), r.ild.toFixed(4),
    r.monoCat3Rate.toFixed(4), r.monoNeighborhoodRate.toFixed(4),
    r.coverage.toFixed(4), r.violations,
  ].join(",");
writeFileSync(
  path.join(ROOT, "analysis/data/reco_quality_summary.csv"),
  [csvHeader, ...results.map(csvRow)].join("\n") + "\n",
);

// ── MD ──
const row = (s: (typeof SCENARIOS)[number]) => {
  const b = by(s.key, "baseline");
  const m = by(s.key, "mmr");
  return (
    `| ${s.label} | ${pct(b.monoCat3Rate)} → **${pct(m.monoCat3Rate)}** | ` +
    `${pct(b.monoNeighborhoodRate)} → **${pct(m.monoNeighborhoodRate)}** | ` +
    `${num(b.ild, 3)} → **${num(m.ild, 3)}** | ` +
    `${num(b.meanPairKm, 1)} → **${num(m.meanPairKm, 1)}**km | ` +
    `${num(b.meanGain, 1)} → ${num(m.meanGain, 1)} |`
  );
};

const worstGainDrop = Math.min(
  ...SCENARIOS.map((s) => by(s.key, "mmr").meanGain - by(s.key, "baseline").meanGain),
);
const totalViolations = results.reduce((a, r) => a + r.violations, 0);

const md = `# 33-결과. 대체지 추천 품질 실측

> **이 파일은 산출물이다 — 직접 수정하지 말 것.**
> 재현: \`cd harinote && pnpm check:reco\`
> 엔진: \`harinote/src/lib/reco/\` @ ${engineRef()}

## 왜 재는가

추천에는 **정답 셋이 없다.** "이 관광지의 올바른 대체지"를 라벨링한 데이터가 없으므로
정확도 지표(Precision@k·NDCG)를 계산할 수 없다. 없는 정답을 지어내는 대신,
**라벨 없이 잴 수 있는 목표**를 측정한다 — 다양성·커버리지·제약 충족률
(Kaminskas & Bridge, *Diversity, Serendipity, Novelty, and Coverage*, ACM TiiS 2016).

안전점수는 민감도 분석으로 설계값을 방어하는데([24](24_safety_sensitivity_result.md))
추천 쪽에 대응물이 없던 비대칭을 메우는 것이 이 하네스의 목적이다.

## 측정 설계

- 실좌표·실분류(\`gangwon.json\` 2,086곳)에 **고정 기상 시나리오 ${SCENARIOS.length}종**을 물려
  실제 점수 엔진(\`computeSafetyScore\`)을 돌린다 — 날씨 API를 타지 않아 언제 돌려도 같은 값
- target = 관광지를 contentId 순으로 정렬해 5곳마다 하나 = **${results[0].targets}곳**
- 서비스가 실제로 쓰는 \`recommendAlternatives\`를 그대로 호출한다 (별도 포팅 없음)
- MMR(λ=${MMR_LAMBDA}) **켠 것과 끈 것**을 같은 입력으로 비교한다

## 결과 — 다양성 재랭킹(MMR)의 효과

| 시나리오 | 전부 같은 분류 | 전부 같은 동네 | ILD | 목록 내 쌍평균거리 | 안전점수 개선폭 |
|---|---|---|---|---|---|
${SCENARIOS.map(row).join("\n")}

**읽는 법**: 앞 네 열은 **낮을수록/높을수록 다양**하고, 마지막 열이 **그 대가**다.
통상 다양성을 올리면 관련도가 깎이는데, 여기서는 개선폭이 최소 ${num(worstGainDrop, 1)}점
변했을 뿐이다 — 밀집 군집의 후보들이 애초에 점수가 거의 같아서, 그중 무엇을 고르든
안전점수 손해가 거의 없기 때문이다.

- **하드 제약 위반 ${totalViolations}건** (반경 30km · 최소 개선 +5점 · 자기 자신 제외).
  재랭킹은 순서만 바꾸고 자격 판정은 건드리지 않는다는 것을 실측으로 확인한다.
- 추천 가능률은 시나리오에 따라 ${pct(Math.min(...results.map((r) => r.fillRate)))}~${pct(Math.max(...results.map((r) => r.fillRate)))}.
  맑은 날 낮은 것은 결함이 아니다 — 대상지가 이미 안전하면 "+5점 이상 나은 곳"이 없다.

## 알려진 한계

- **정확도는 여전히 못 잰다.** 이 표의 어떤 숫자도 "추천이 사용자에게 유용하다"를
  증명하지 않는다. 다양성·제약 충족은 *필요조건*이지 충분조건이 아니다.
- **커버리지가 낮다** — 추천이 닿는 고유 장소가 추천 가능 풀의
  ${pct(Math.min(...results.map((r) => r.coverage)))}~${pct(Math.max(...results.map((r) => r.coverage)))}에 그친다.
  안전점수 상위권이 반복 추천되는 구조적 쏠림이고, 롱테일 노출은 후속 과제다.
- 고정 시나리오 ${SCENARIOS.length}종은 날씨 공간을 대표하지 않는다. 다양성은 카탈로그의
  지리·분류 구조에서 주로 나오므로 시나리오 수에 둔감하지만, 추천 가능률은 민감하다.
`;
writeFileSync(path.join(ROOT, "analysis/33_reco_quality_result.md"), md);
console.log(
  "기록: analysis/data/reco_quality_summary.csv · analysis/33_reco_quality_result.md",
);
