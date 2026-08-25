export class ContainerTerminationUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerTerminationUnknownError";
  }
}

/** The container's signed result was missing, malformed, or failed HMAC
 *  verification. Non-retryable: the container has already run, so a re-run would
 *  repeat any side effects the agent already performed (e.g. a sent email or a
 *  created task), and an authentic result can only come from the entrypoint —
 *  the sole holder of the per-run signing key. Lives here (not in the runner) so
 *  vi.mock of the runner can't break `instanceof` in the queue. */
export class OutputVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputVerificationError";
  }
}
