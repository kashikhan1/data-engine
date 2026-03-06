/* eslint-disable @typescript-eslint/no-explicit-any */
export type QueryGenerationContext = {
  plan: any;
  schema: any;
  filters?: Record<string, any>;
};

export function buildQueryGenerationContext(input: QueryGenerationContext) {
  return {
    plan: input.plan,
    schema: input.schema,
    filters: input.filters || {},
  };
}
