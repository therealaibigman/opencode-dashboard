export type PlanRisk = 'low' | 'med' | 'high';

export type PlanStep = {
  title: string;
  details: string;
  risk?: PlanRisk;
};

export type PlanJson = {
  summary: string;
  steps: PlanStep[];
  files: string[];
  commands: string[];
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function asStr(x: unknown) {
  return typeof x === 'string' ? x : '';
}

function asStrArr(x: unknown) {
  if (!Array.isArray(x)) return [];
  return x.filter((v) => typeof v === 'string') as string[];
}

function asRisk(x: unknown): PlanRisk | undefined {
  if (x === 'low' || x === 'med' || x === 'high') return x;
  return undefined;
}

export function validatePlanJson(text: string):
  | { ok: true; plan: PlanJson }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { ok: false, error: `invalid json: ${String(e?.message ?? e)}` };
  }

  if (!isObj(parsed)) return { ok: false, error: 'plan must be a JSON object' };

  const summary = asStr(parsed.summary).trim();
  const files = asStrArr(parsed.files);
  const commands = asStrArr(parsed.commands);

  const stepsRaw = (parsed as any).steps;
  if (!Array.isArray(stepsRaw)) return { ok: false, error: 'plan.steps must be an array' };

  const steps: PlanStep[] = stepsRaw
    .filter((s) => isObj(s))
    .map((s) => {
      const title = asStr((s as any).title).trim() || 'Step';
      const details = asStr((s as any).details).trim();
      const risk = asRisk((s as any).risk);
      return { title, details, ...(risk ? { risk } : {}) };
    });

  return {
    ok: true,
    plan: {
      summary,
      steps,
      files,
      commands
    }
  };
}
