import { ErrorCodes } from "./codes";

export interface AppErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: AppErrorDetails;

  constructor(code: string, message: string, status: number = 500, details?: AppErrorDetails) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(ErrorCodes.NOT_FOUND, message, 404);
  }

  static internal(message = "Internal error"): AppError {
    return new AppError(ErrorCodes.INTERNAL_ERROR, message, 500);
  }

  static validation(details?: AppErrorDetails): AppError {
    return new AppError(ErrorCodes.VALIDATION_ERROR, "Validation failed", 400, details);
  }
}
