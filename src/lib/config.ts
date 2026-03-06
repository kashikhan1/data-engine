export const PlannerConfig = {
  ACCEPTANCE_THRESHOLD: 85,
  EARLY_EXIT_THRESHOLD: 90,
  MAX_ITERATIONS: 3,
  MAX_REPAIR_ATTEMPTS: 3,
  VALIDATION_THRESHOLD: 70,
  CRITIQUE_THRESHOLD: 80,
  DEFAULT_MAX_TABLES: 10,
  DEFAULT_MAX_COLUMNS: 10,
} as const;

export const WidgetPriority = {
  KPI: 3,
  TABLE: 2,
  CHART: 1,
  LINE: 1,
  BAR: 1,
  AREA: 1,
  PIE: 1,
  SCATTER: 1,
} as const;

export const SqlEngineerConfig = {
  MAX_REPAIR_ATTEMPTS: 3,
  VALIDATION_THRESHOLD: 70,
  CRITIQUE_THRESHOLD: 80,
  ACCEPTANCE_THRESHOLD: 85,
  EARLY_EXIT_THRESHOLD: 90,
} as const;

export const CacheConfig = {
  SCHEMA_TTL_MS: 5 * 60 * 1000, // 5 minutes
} as const;

export const ErrorMessages = {
  CONNECTION_REFUSED: "Cannot connect to database. Please check your connection settings and ensure the database is running.",
  TIMEOUT: "Connection timed out. The database may be slow or unreachable. Please try again.",
  AUTH_FAILED: "Authentication failed. Please check your username and password.",
  PERMISSION_DENIED: "Access denied. Your user doesn't have permission to access this database.",
  NO_CONNECTION: "Connect to a database via the Data Sources panel before running schema discovery.",
} as const;
