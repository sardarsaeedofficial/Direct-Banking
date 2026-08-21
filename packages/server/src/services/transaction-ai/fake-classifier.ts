import type { ClassifierInput, ClassifierOutput, TransactionSemanticClassifier } from "./types.js";

/**
 * A deterministic, in-memory test double — never calls a real AI provider,
 * so automated tests exercise the AI-advisory code paths without any real
 * API key. Tests configure exact expected responses (or force an
 * invalid/error/timeout condition) via the fields below.
 */
export class FakeSemanticClassifier implements TransactionSemanticClassifier {
  readonly name = "fake";
  response: ClassifierOutput | null = null;
  /** When set, `classify()` returns this raw (possibly schema-invalid) value
   *  instead of `response` — for testing the caller's validate-and-discard
   *  path. Bypasses this class's own type safety deliberately. */
  rawResponseOverride: unknown = undefined;
  throwError: Error | null = null;
  delayMs = 0;
  calls: ClassifierInput[] = [];

  async classify(input: ClassifierInput): Promise<ClassifierOutput | null> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.throwError) throw this.throwError;
    if (this.rawResponseOverride !== undefined) return this.rawResponseOverride as ClassifierOutput;
    return this.response;
  }
}
