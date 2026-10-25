// Статистика считается сервером по уникальным claims (ТЗ 7, этап C). Мнения не входят в знаменатель.

import { type AnalysisStats, type Claim, VERDICTS, type Verdict } from "../../../shared/contract.ts";

export function computeStats(claims: Pick<Claim, "status" | "verdict">[]): AnalysisStats {
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  const stats: AnalysisStats = { total: 0, completed: 0, notCompleted: 0, byVerdict, failed: 0, notChecked: 0, opinions: 0 };
  for (const c of claims) {
    if (c.status === "opinion") {
      stats.opinions++;
      continue;
    }
    stats.total++;
    if (c.status === "checked" && c.verdict) {
      stats.completed++;
      byVerdict[c.verdict]++;
    } else if (c.status === "failed") {
      stats.completed++;
      stats.failed++;
    } else {
      stats.notCompleted++;
      if (c.status === "not_checked") stats.notChecked++;
    }
  }
  return stats;
}
