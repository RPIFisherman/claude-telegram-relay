import { basename } from "path";

const DEFAULT_UPLOAD_NAME = "upload.bin";
const DEFAULT_FILENAME_LENGTH = 120;

const DEFAULT_CLAUDE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
];

export type TelegramAccessDecision =
  | "allow"
  | "reject_chat_not_allowed"
  | "reject_unconfigured";

export interface TelegramAllowlist {
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
}

export function parseIdList(rawValue?: string): string[] {
  return (rawValue || "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildTelegramAllowlist(
  env: Record<string, string | undefined>
): TelegramAllowlist {
  return {
    allowedUserIds: new Set([
      ...parseIdList(env.TELEGRAM_ALLOWED_USER_IDS),
      ...parseIdList(env.TELEGRAM_USER_ID),
    ]),
    allowedChatIds: new Set(parseIdList(env.TELEGRAM_ALLOWED_CHAT_IDS)),
  };
}

function toIdSet(values: Iterable<string>): Set<string> {
  return values instanceof Set ? values : new Set(values);
}

export function getTelegramAccessDecision(input: {
  allowedUserIds: Iterable<string>;
  allowedChatIds: Iterable<string>;
  fromId?: string | null;
  chatId?: string | number | null;
  chatType?: string | null;
}): TelegramAccessDecision {
  const allowedUserIds = toIdSet(input.allowedUserIds);
  const allowedChatIds = toIdSet(input.allowedChatIds);
  const fromId = input.fromId || null;
  const chatId =
    input.chatId === null || input.chatId === undefined
      ? null
      : String(input.chatId);

  if (allowedUserIds.size === 0 && allowedChatIds.size === 0) {
    return "reject_unconfigured";
  }

  const userAllowed = fromId ? allowedUserIds.has(fromId) : false;
  const chatAllowed = chatId ? allowedChatIds.has(chatId) : false;

  if (input.chatType === "private") {
    return userAllowed || chatAllowed ? "allow" : "reject_chat_not_allowed";
  }

  if (input.chatType === "channel") {
    return chatAllowed ? "allow" : "reject_chat_not_allowed";
  }

  if (!chatAllowed) {
    return "reject_chat_not_allowed";
  }

  return userAllowed ? "allow" : "reject_chat_not_allowed";
}

export function sanitizeUploadFilename(
  originalName?: string,
  fallbackName = DEFAULT_UPLOAD_NAME
): string {
  const base = basename(originalName || fallbackName).replace(/\0/g, "");
  const sanitized = base
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .replace(/_+/g, "_")
    .slice(0, DEFAULT_FILENAME_LENGTH);

  return sanitized || fallbackName;
}

export function buildClaudeEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const allowed = new Set(DEFAULT_CLAUDE_ENV_KEYS);
  const extraKeys = (env.CLAUDE_ENV_ALLOWLIST || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  for (const key of extraKeys) {
    allowed.add(key);
  }

  const safeEnv: Record<string, string> = {};

  for (const key of allowed) {
    const value = env[key];
    if (value) {
      safeEnv[key] = value;
    }
  }

  return safeEnv;
}

export function isWithinLimit(
  sizeBytes: number | undefined,
  maxBytes: number
): boolean {
  return typeof sizeBytes !== "number" || sizeBytes <= maxBytes;
}

export function parsePositiveInt(
  rawValue: string | undefined,
  defaultValue: number
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
