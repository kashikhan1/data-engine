export type CurrentDateTimeContext = {
  todayDate: string;
  todayDateTime: string;
  currentTimeZone: string;
  nowIsoUtc: string;
};

/**
 * Planner date-time context helper.
 * Keeps relative date interpretation anchored to "today" for all planner prompts.
 */
export function getCurrentDateTimeContext(): CurrentDateTimeContext {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const todayDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const todayDateTime = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  return {
    todayDate,
    todayDateTime,
    currentTimeZone: timeZone,
    nowIsoUtc: now.toISOString(),
  };
}
