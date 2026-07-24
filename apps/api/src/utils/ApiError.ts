/** Operational error with an HTTP status and machine-readable code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'BAD_REQUEST') {
    return new ApiError(400, code, message);
  }
  static unauthorized(message = 'Not authenticated', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'Not allowed', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }
  static notFound(message = 'Not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }
  static tooMany(message: string, code = 'TOO_MANY_REQUESTS') {
    return new ApiError(429, code, message);
  }
}
