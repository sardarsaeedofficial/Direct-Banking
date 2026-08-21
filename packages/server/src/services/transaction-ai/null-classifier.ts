import type { ClassifierInput, ClassifierOutput, TransactionSemanticClassifier } from "./types.js";

/** The default classifier when TRANSACTION_AI_ENABLED=false (or no provider
 *  is configured). Always returns null — "no AI opinion" — so every caller's
 *  fallback path (pure deterministic classification) is exercised by
 *  default, in production, with no provider configured. */
export class NullSemanticClassifier implements TransactionSemanticClassifier {
  readonly name = "null";
  async classify(_input: ClassifierInput): Promise<ClassifierOutput | null> {
    return null;
  }
}
