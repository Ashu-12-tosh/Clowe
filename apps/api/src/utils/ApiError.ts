/** Operational error with an HTTP status and machine-readable code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The input the error is about, when there is one: the form marks it. */
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A 400 about one input. */
  static invalidField(field: string, message: string, code = 'VALIDATION_ERROR') {
    return new ApiError(400, code, message, field);
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
