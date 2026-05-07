import { Router } from "express";
import {
  db,
  requestsTable,
  subscriptionsTable,
  usersTable,
  topupsTable,
  styleSettingsTable,
} from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";

const router = Router();

const RANGE_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

router.get("/reports/admin", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const rawRange = String(req.query.range ?? "30d");
    const days = RANGE_DAYS[rawRange] ?? 30;
    const range = (RANGE_DAYS[rawRange] ? rawRange : "30d") as
      "7d" | "30d" | "90d" | "365d";

    // Bucket by UTC day so the time series and totals agree on "today".
    // rangeStart = midnight UTC of (days-1) days ago, rangeEnd = now (inclusive).
    const rangeEnd = new Date();
    const startDay = new Date(Date.UTC(
      rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate(),
    ));
    startDay.setUTCDate(startDay.getUTCDate() - (days - 1));
    const rangeStart = startDay;

    const [
      allCustomers,
      allSubs,
      reqsInRange,
      topupsInRange,
      styleRow,
    ] = await Promise.all([
      db.select().from(usersTable).where(
        and(eq(usersTable.role, "customer"), eq(usersTable.workspaceId, workspace.id)),
      ),
      db.select().from(subscriptionsTable).where(eq(subscriptionsTable.workspaceId, workspace.id)),
      db.select().from(requestsTable).where(
        and(
          eq(requestsTable.workspaceId, workspace.id),
          gte(requestsTable.createdAt, rangeStart),
          lte(requestsTable.createdAt, rangeEnd),
        ),
      ),
      db.select().from(topupsTable).where(
        and(
          eq(topupsTable.workspaceId, workspace.id),
          eq(topupsTable.status, "confirmed"),
          gte(topupsTable.createdAt, rangeStart),
          lte(topupsTable.createdAt, rangeEnd),
        ),
      ),
      db.select().from(styleSettingsTable).where(eq(styleSettingsTable.workspaceId, workspace.id)),
    ]);

    const currency = styleRow[0]?.defaultCurrency ?? "USD";

    const activeRetainers = allSubs.filter((s) => s.status === "active").length;
    const totalMinutesUsed = reqsInRange.reduce((sum, r) => sum + (r.usedMinutes ?? 0), 0);
    const totalSpend = topupsInRange.reduce((sum, t) => sum + Number(t.amount), 0);
    const avgBurnRateMinutesPerDay = days > 0 ? totalMinutesUsed / days : 0;

    // Build daily time series
    const seriesMap = new Map<string, { requests: number; minutesUsed: number; spend: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(rangeStart.getTime() + i * 24 * 60 * 60 * 1000);
      seriesMap.set(isoDate(d), { requests: 0, minutesUsed: 0, spend: 0 });
    }
    for (const r of reqsInRange) {
      const key = isoDate(new Date(r.createdAt));
      const slot = seriesMap.get(key);
      if (slot) {
        slot.requests += 1;
        slot.minutesUsed += r.usedMinutes ?? 0;
      }
    }
    for (const t of topupsInRange) {
      const key = isoDate(new Date(t.createdAt));
      const slot = seriesMap.get(key);
      if (slot) slot.spend += Number(t.amount);
    }
    const timeSeries = Array.from(seriesMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    // Per-client aggregation
    const subsByCustomer = new Map<number, typeof allSubs>();
    for (const s of allSubs) {
      const arr = subsByCustomer.get(s.customerId) ?? [];
      arr.push(s);
      subsByCustomer.set(s.customerId, arr);
    }

    const reqAggByCustomer = new Map<number, { requests: number; minutesUsed: number }>();
    for (const r of reqsInRange) {
      const cur = reqAggByCustomer.get(r.customerId) ?? { requests: 0, minutesUsed: 0 };
      cur.requests += 1;
      cur.minutesUsed += r.usedMinutes ?? 0;
      reqAggByCustomer.set(r.customerId, cur);
    }

    const spendByCustomer = new Map<number, number>();
    for (const t of topupsInRange) {
      spendByCustomer.set(t.customerId, (spendByCustomer.get(t.customerId) ?? 0) + Number(t.amount));
    }

    const byClient = allCustomers
      .map((c) => {
        const subs = subsByCustomer.get(c.id) ?? [];
        const remainingMinutes = subs
          .filter((s) => s.status === "active" && s.totalMinutes < 999999)
          .reduce((sum, s) => sum + Math.max(0, s.totalMinutes - s.usedMinutes), 0);
        const agg = reqAggByCustomer.get(c.id) ?? { requests: 0, minutesUsed: 0 };
        const spend = spendByCustomer.get(c.id) ?? 0;
        const burnRateMinutesPerDay = days > 0 ? agg.minutesUsed / days : 0;
        return {
          customerId: c.id,
          customerName: c.name ?? null,
          customerEmail: c.email ?? null,
          requests: agg.requests,
          minutesUsed: agg.minutesUsed,
          spend,
          remainingMinutes,
          burnRateMinutesPerDay,
        };
      })
      .sort((a, b) => b.minutesUsed - a.minutesUsed || b.requests - a.requests);

    return res.json({
      range,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      totals: {
        clients: allCustomers.length,
        activeRetainers,
        requests: reqsInRange.length,
        minutesUsed: totalMinutesUsed,
        spend: totalSpend,
        currency,
        avgBurnRateMinutesPerDay,
      },
      timeSeries,
      byClient,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting admin reports");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
