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
  | "ignore_non_private"
  | "reject_unauthorized"
  | "reject_unconfigured";

export function getTelegramAccessDecision(input: {
  allowedUserId: string;
  fromId?: string | null;
  chatType?: string | null;
}): TelegramAccessDecision {
  if (!input.allowedUserId) {
    return "reject_unconfigured";
  }

  if (input.chatType !== "private") {
    return "ignore_non_private";
  }

  if (!input.fromId || input.fromId !== input.allowedUserId) {
    return "reject_unauthorized";
  }

  return "allow";
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
