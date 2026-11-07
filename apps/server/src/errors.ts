/** Errors that map to HTTP statuses / ack messages at the boundary. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'not found') {
    super(404, message, 'not_found');
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'forbidden') {
    super(403, message, 'forbidden');
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'bad request') {
    super(400, message, 'bad_request');
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'conflict') {
    super(409, message, 'conflict');
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
