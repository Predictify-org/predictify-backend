import "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      stellarAddress: string;
    }

    interface Request {
      user?: User;
    }
  }
}
