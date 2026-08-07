/** 时间来源：所有持久化时间戳由注入的 Clock 产生（UTC ISO-8601）。 */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

/** 测试用可推进时钟。 */
export function createManualClock(startIso: string): Clock & { advance(ms: number): void } {
  let current = Date.parse(startIso);
  return {
    now(): string {
      return new Date(current).toISOString();
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}
