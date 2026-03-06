export function dedupeSqlClauses(baseSql: string, clauses: string[]) {
  const trimmed = String(baseSql || "").trim();
  const lower = trimmed.toLowerCase();
  return clauses.filter((c) => !lower.includes(String(c || "").toLowerCase()));
}
