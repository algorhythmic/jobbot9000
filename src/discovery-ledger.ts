// Opt-in private runtime bridge: importing db opens only configured .private state.
// Serial owner only. Durable budgets/spacing are not cross-process inflight locks.
import { reserveDiscoveryRead } from "./db.js";
import { memoryReadLedger, type ReadLedger } from "./discovery.js";

export function privateReadLedger(): ReadLedger {
  const local = memoryReadLedger();
  return {
    async acquire(host, now, sleep, dailyLimit) {
      // The durable ledger owns the global budget; this instance supplies the
      // local inflight slot/spacing. Failed reservations still release that slot.
      const release = await local.acquire(host, now, sleep, Number.MAX_SAFE_INTEGER);
      try {
        while (true) {
          const wait = reserveDiscoveryRead(host, now(), dailyLimit);
          if (!wait) return release;
          await sleep(wait);
        }
      } catch (error) { release(); throw error; }
    },
  };
}
