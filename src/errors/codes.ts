export const ErrorCodes = {
  INTERNAL_ERROR: "internal_error",
  NOT_FOUND: "not_found",
  VALIDATION_ERROR: "validation_error",
  REQUEST_FAILED: "request_failed",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
