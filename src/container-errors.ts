export class ContainerTerminationUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerTerminationUnknownError";
  }
}
