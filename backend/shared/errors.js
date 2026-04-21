export class AppError extends Error {
  constructor(message, { code = "app_error", statusCode = 500, retryable = false, field = null, cause = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.field = field;
    if (cause !== null && cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message, field = null, cause = null) {
    super(message, {
      code: "validation_error",
      statusCode: 400,
      retryable: false,
      field,
      cause
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "authentication_required", cause = null) {
    super(message, {
      code: "authentication_error",
      statusCode: 401,
      retryable: false,
      cause
    });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "rate_limited", cause = null) {
    super(message, {
      code: "rate_limit_error",
      statusCode: 429,
      retryable: true,
      cause
    });
  }
}

export class DatabaseError extends AppError {
  constructor(message = "database_error", cause = null) {
    super(message, {
      code: "database_error",
      statusCode: 503,
      retryable: true,
      cause
    });
  }
}

export function toErrorPayload(error, fallbackCode = "error") {
  return {
    error: error?.code || fallbackCode,
    message: error?.message || fallbackCode,
    field: error?.field ?? null,
    retryable: Boolean(error?.retryable),
    statusCode: Number(error?.statusCode || 500)
  };
}
