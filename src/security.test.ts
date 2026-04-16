import { describe, expect, test } from "bun:test";
import {
  buildClaudeEnv,
  getTelegramAccessDecision,
  isWithinLimit,
  parsePositiveInt,
  sanitizeUploadFilename,
} from "./security.ts";

describe("getTelegramAccessDecision", () => {
  test("fails closed when no allowed user is configured", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserId: "",
        fromId: "123",
        chatType: "private",
      })
    ).toBe("reject_unconfigured");
  });

  test("rejects non-private chats", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserId: "123",
        fromId: "123",
        chatType: "group",
      })
    ).toBe("ignore_non_private");
  });

  test("rejects the wrong user", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserId: "123",
        fromId: "456",
        chatType: "private",
      })
    ).toBe("reject_unauthorized");
  });

  test("allows the configured user in a private chat", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserId: "123",
        fromId: "123",
        chatType: "private",
      })
    ).toBe("allow");
  });
});

describe("sanitizeUploadFilename", () => {
  test("removes path traversal segments", () => {
    expect(sanitizeUploadFilename("../../../.ssh/authorized_keys")).toBe(
      "authorized_keys"
    );
  });

  test("normalizes slashes and unsafe characters", () => {
    expect(sanitizeUploadFilename("quarterly report (final).pdf")).toBe(
      "quarterly_report_final_.pdf"
    );
  });

  test("falls back when the input collapses to nothing", () => {
    expect(sanitizeUploadFilename("....")).toBe("upload.bin");
  });
});

describe("buildClaudeEnv", () => {
  test("keeps Claude runtime env and drops relay secrets by default", () => {
    expect(
      buildClaudeEnv({
        HOME: "/home/test",
        PATH: "/usr/bin",
        TELEGRAM_BOT_TOKEN: "secret",
        SUPABASE_SERVICE_ROLE_KEY: "secret",
      })
    ).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin",
    });
  });

  test("allows explicit extra keys", () => {
    expect(
      buildClaudeEnv({
        HOME: "/home/test",
        CLAUDE_ENV_ALLOWLIST: "CUSTOM_TOKEN",
        CUSTOM_TOKEN: "value",
      })
    ).toEqual({
      HOME: "/home/test",
      CUSTOM_TOKEN: "value",
    });
  });
});

describe("limit helpers", () => {
  test("accepts unknown file sizes", () => {
    expect(isWithinLimit(undefined, 10)).toBe(true);
  });

  test("rejects files above the cap", () => {
    expect(isWithinLimit(11, 10)).toBe(false);
  });

  test("parses positive ints and falls back otherwise", () => {
    expect(parsePositiveInt("42", 10)).toBe(42);
    expect(parsePositiveInt("0", 10)).toBe(10);
    expect(parsePositiveInt("abc", 10)).toBe(10);
  });
});
