import { describe, expect, test } from "bun:test";
import {
  buildTelegramAllowlist,
  buildClaudeEnv,
  getTelegramAccessDecision,
  isWithinLimit,
  parsePositiveInt,
  parseIdList,
  sanitizeUploadFilename,
} from "./security.ts";

describe("getTelegramAccessDecision", () => {
  test("fails closed when no allowed user is configured", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: [],
        allowedChatIds: [],
        fromId: "123",
        chatId: "123",
        chatType: "private",
      })
    ).toBe("reject_unconfigured");
  });

  test("allows a configured private user", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: ["123"],
        allowedChatIds: [],
        fromId: "123",
        chatId: "123",
        chatType: "private",
      })
    ).toBe("allow");
  });

  test("allows a configured private chat", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: [],
        allowedChatIds: ["123"],
        fromId: "456",
        chatId: "123",
        chatType: "private",
      })
    ).toBe("allow");
  });

  test("rejects the wrong private user", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: ["123"],
        allowedChatIds: [],
        fromId: "456",
        chatId: "456",
        chatType: "private",
      })
    ).toBe("reject_chat_not_allowed");
  });

  test("requires an allowlisted chat for groups", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: ["123"],
        allowedChatIds: [],
        fromId: "123",
        chatId: "-1001",
        chatType: "supergroup",
      })
    ).toBe("reject_chat_not_allowed");
  });

  test("requires an allowlisted sender in allowlisted groups", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: ["123"],
        allowedChatIds: ["-1001"],
        fromId: "456",
        chatId: "-1001",
        chatType: "supergroup",
      })
    ).toBe("reject_chat_not_allowed");
  });

  test("allows trusted users in trusted groups", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: ["123"],
        allowedChatIds: ["-1001"],
        fromId: "123",
        chatId: "-1001",
        chatType: "supergroup",
      })
    ).toBe("allow");
  });

  test("allows allowlisted channels by chat id", () => {
    expect(
      getTelegramAccessDecision({
        allowedUserIds: [],
        allowedChatIds: ["-1009"],
        chatId: "-1009",
        chatType: "channel",
      })
    ).toBe("allow");
  });
});

describe("allowlist parsing", () => {
  test("splits comma and whitespace separated ids", () => {
    expect(parseIdList("123, 456\n789")).toEqual(["123", "456", "789"]);
  });

  test("builds user and chat allowlists from env", () => {
    const allowlist = buildTelegramAllowlist({
      TELEGRAM_USER_ID: "111",
      TELEGRAM_ALLOWED_USER_IDS: "222,333",
      TELEGRAM_ALLOWED_CHAT_IDS: "-1001 -1002",
    });

    expect(Array.from(allowlist.allowedUserIds).sort()).toEqual([
      "111",
      "222",
      "333",
    ]);
    expect(Array.from(allowlist.allowedChatIds).sort()).toEqual([
      "-1001",
      "-1002",
    ]);
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
