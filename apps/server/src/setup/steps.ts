import type { SetupLog } from "./log";

/** Error with a stable code the installer translates into a clear message (ar/fr). */
export class SetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Step {
  name: string;
  /** Error code reported if this step fails. */
  code: string;
  run: () => Promise<void> | void;
  /** Undo what `run` did. Called only if `run` finished and a later step failed. */
  undo?: () => Promise<void> | void;
}

export interface StepsResult {
  ok: boolean;
  failedStep?: string;
  errorCode?: string;
  message?: string;
}

/**
 * Runs steps in order. On the first failure, undoes the finished steps in reverse
 * order, so the computer is left as it was before setup (SPEC 6.1 "clean rollback").
 * `simulateFailureAt` lets automated tests prove the rollback really works.
 */
export async function runSteps(steps: Step[], log: SetupLog, simulateFailureAt?: string): Promise<StepsResult> {
  const done: Step[] = [];
  for (const step of steps) {
    log.info(`STEP ${step.name}: start`);
    try {
      if (simulateFailureAt === step.name) {
        throw new SetupError("E_SIMULATED", `Simulated failure at step ${step.name}`);
      }
      await step.run();
      done.push(step);
      log.info(`STEP ${step.name}: ok`);
    } catch (error) {
      const code = error instanceof SetupError ? error.code : step.code;
      const message = error instanceof Error ? error.message : String(error);
      log.info(`STEP ${step.name}: FAILED (${code}) ${message}`);
      await rollback(done, log);
      return { ok: false, failedStep: step.name, errorCode: code, message: log.redact(message) };
    }
  }
  return { ok: true };
}

async function rollback(done: Step[], log: SetupLog): Promise<void> {
  for (const step of [...done].reverse()) {
    if (!step.undo) continue;
    try {
      log.info(`UNDO ${step.name}: start`);
      await step.undo();
      log.info(`UNDO ${step.name}: ok`);
    } catch (error) {
      // Keep going: undo as much as possible, and record what could not be undone.
      log.info(`UNDO ${step.name}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
