/** Checks ownership and human control without reading the renderer. */
export class ControlAuthorityError extends Error {
  constructor(rpcError) {
    super(rpcError.message);
    this.rpcError = rpcError;
    this.name = 'ControlAuthorityError';
  }
}
