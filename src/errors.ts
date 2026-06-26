export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "not_found", message);
  }
}

export class MarketClosedError extends AppError {
  constructor() {
    super(409, "market_closed", "Market is not active or has passed resolution time");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "validation_error", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}
