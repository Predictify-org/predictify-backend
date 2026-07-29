import request from "supertest";
import { createApp } from "../src/index";
import * as refreshTokenService from "../src/services/refreshTokenService";

jest.mock("../src/services/refreshTokenService", () => ({
  ...jest.requireActual("../src/services/refreshTokenService"),
  revokeFamily: jest.fn(),
}));

const mockRevokeFamily = refreshTokenService.revokeFamily as jest.Mock;

describe("POST /api/auth/wallet/logout", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => jest.clearAllMocks());

  it("revokes the token family and returns 204", async () => {
    mockRevokeFamily.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/auth/wallet/logout")
      .send({ refreshToken: "some-refresh-token" });

    expect(res.status).toBe(204);
    expect(mockRevokeFamily).toHaveBeenCalledWith("some-refresh-token");
  });

  it("rejects requests without a refresh token", async () => {
    const res = await request(app).post("/api/auth/wallet/logout").send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(mockRevokeFamily).not.toHaveBeenCalled();
  });
});
