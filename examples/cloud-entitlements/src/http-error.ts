/** Safe HTTP status and machine code; never carries credentials or raw context. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "HttpError";
  }
}
