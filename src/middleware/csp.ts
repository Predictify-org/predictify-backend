import type { RequestHandler } from "express";
import helmet from "helmet";

const SWAGGER_CDN_ORIGINS = ["https://cdn.jsdelivr.net"] as const;

export function createDocsCspMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "https://validator.swagger.io"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'", ...SWAGGER_CDN_ORIGINS],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", ...SWAGGER_CDN_ORIGINS],
        connectSrc: ["'self'", ...SWAGGER_CDN_ORIGINS],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
}

export function createGlobalCspMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:"],
        upgradeInsecureRequests: [],
      },
    },
  });
}
