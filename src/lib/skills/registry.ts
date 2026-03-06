import { createLogger } from "../observability";

const log = createLogger("skills.registry");

export interface SkillContext {
  traceId?: string;
  metadata?: Record<string, unknown>;
  onToken?: (token: string, meta?: { skillId?: string }) => void;
}

export interface SkillDefinition<I = unknown, O = unknown> {
  id: string;
  description: string;
  run: (input: I, context?: SkillContext) => Promise<O>;
}

type AnySkillDefinition = SkillDefinition<unknown, unknown>;

const registry = new Map<string, AnySkillDefinition>();

export function registerSkill<I = unknown, O = unknown>(skill: SkillDefinition<I, O>): void {
  registry.set(skill.id, skill as AnySkillDefinition);
  log.debug("skill_registered", { id: skill.id });
}

export function getSkill<TIn = unknown, TOut = unknown>(id: string): SkillDefinition<TIn, TOut> | null {
  return (registry.get(id) as SkillDefinition<TIn, TOut> | undefined) || null;
}

export function listSkills(): Array<Pick<SkillDefinition, "id" | "description">> {
  return Array.from(registry.values()).map((skill) => ({ id: skill.id, description: skill.description }));
}

export async function runSkill<TIn = unknown, TOut = unknown>(
  id: string,
  input: TIn,
  context?: SkillContext
): Promise<TOut> {
  const skill = getSkill<TIn, TOut>(id);
  if (!skill) {
    throw new Error(`Unknown skill: ${id}`);
  }
  log.debug("skill_run", { id, traceId: context?.traceId });
  return skill.run(input, context);
}
