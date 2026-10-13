import { getAllRunnableGroups, getLastRealRunAt } from "@/lib/db";
import { enqueueGroups, pumpJobs } from "@/lib/jobs";
import { isIdleTime } from "@/lib/time";
export { isIdleTime } from "@/lib/time";

const globalScheduler = globalThis as unknown as { benchmarkScheduler?: ReturnType<typeof setInterval> };
function tick() {
  pumpJobs();
  for (const group of getAllRunnableGroups()) {
    const lastRunAt = getLastRealRunAt(group.id);
    const interval = isIdleTime() ? group.idle_interval_minutes : group.interval_minutes;
    if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < interval * 60_000) continue;
    try { enqueueGroups([group.id]); } catch (error) { console.error("[scheduler]", group.name, error); }
  }
}
export function ensureScheduler() {
  if (globalScheduler.benchmarkScheduler) return;
  tick();
  globalScheduler.benchmarkScheduler = setInterval(tick, 30_000);
  globalScheduler.benchmarkScheduler.unref?.();
}
