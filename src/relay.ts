/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { unlinkSync } from "fs";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import {
  buildTelegramAllowlist,
  buildClaudeEnv,
  getTelegramAccessDecision,
  isWithinLimit,
  parsePositiveInt,
  sanitizeUploadFilename,
} from "./security.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const TELEGRAM_ALLOWLIST = buildTelegramAllowlist(process.env);
const MAX_TEXT_CHARS = parsePositiveInt(process.env.MAX_TEXT_CHARS, 12000);
const MAX_IMAGE_BYTES = parsePositiveInt(process.env.MAX_IMAGE_BYTES, 10 * 1024 * 1024);
const MAX_DOCUMENT_BYTES = parsePositiveInt(
  process.env.MAX_DOCUMENT_BYTES,
  10 * 1024 * 1024
);
const MAX_VOICE_BYTES = parsePositiveInt(process.env.MAX_VOICE_BYTES, 20 * 1024 * 1024);
const MAX_REQUESTS_PER_MINUTE = parsePositiveInt(
  process.env.MAX_REQUESTS_PER_MINUTE,
  12
);
const REQUEST_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString(), { mode: 0o600 });
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

if (
  TELEGRAM_ALLOWLIST.allowedUserIds.size === 0 &&
  TELEGRAM_ALLOWLIST.allowedChatIds.size === 0
) {
  console.error("Telegram allowlist not configured!");
  console.log("\nSet TELEGRAM_ALLOWED_USER_IDS and/or TELEGRAM_ALLOWED_CHAT_IDS.");
  console.log("Legacy TELEGRAM_USER_ID is still supported as a single-user fallback.");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
await mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

if (SUPABASE_URL && !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "SUPABASE_URL is set without SUPABASE_SERVICE_ROLE_KEY. Persistent memory is disabled."
  );
}

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const decision = getTelegramAccessDecision({
    allowedUserIds: TELEGRAM_ALLOWLIST.allowedUserIds,
    allowedChatIds: TELEGRAM_ALLOWLIST.allowedChatIds,
    fromId: ctx.from?.id.toString(),
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
  });

  if (decision === "reject_chat_not_allowed") {
    console.log(
      `Rejected chat access: chat=${ctx.chat?.id} user=${ctx.from?.id ?? "unknown"}`
    );
    await ctx.reply("This bot is private.");
    return;
  }

  if (decision !== "allow") {
    console.log("Access denied: Telegram allowlist is not configured correctly.");
    return;
  }

  const now = Date.now();
  while (
    requestTimestamps.length > 0 &&
    now - requestTimestamps[0] > REQUEST_WINDOW_MS
  ) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    await ctx.reply("Too many requests. Please wait a minute and try again.");
    return;
  }

  requestTimestamps.push(now);
  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: buildClaudeEnv(process.env),
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  if (text.length > MAX_TEXT_CHARS) {
    await ctx.reply(
      `Message too long. Limit is ${MAX_TEXT_CHARS.toLocaleString()} characters.`
    );
    return;
  }

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: semantic search + facts/goals
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    if (!isWithinLimit(voice.file_size, MAX_VOICE_BYTES)) {
      await ctx.reply(
        `Voice message too large. Limit is ${Math.floor(
          MAX_VOICE_BYTES / (1024 * 1024)
        )} MB.`
      );
      return;
    }

    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];

    if (!isWithinLimit(photo.file_size, MAX_IMAGE_BYTES)) {
      await ctx.reply(
        `Image too large. Limit is ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`
      );
      return;
    }

    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const filePath = join(UPLOADS_DIR, `image_${randomUUID()}.jpg`);

    try {
      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer), { mode: 0o600 });

      // Claude Code can see images via file path
      const caption = ctx.message.caption || "Analyze this image.";
      const prompt = `[Image: ${filePath}]\n\n${caption}`;

      await saveMessage("user", `[Image]: ${caption}`);

      const claudeResponse = await callClaude(prompt, { resume: true });
      const cleanResponse = await processMemoryIntents(supabase, claudeResponse);

      await saveMessage("assistant", cleanResponse);
      await sendResponse(ctx, cleanResponse);
    } finally {
      await unlink(filePath).catch(() => {});
    }
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    if (!isWithinLimit(doc.file_size, MAX_DOCUMENT_BYTES)) {
      await ctx.reply(
        `Document too large. Limit is ${Math.floor(
          MAX_DOCUMENT_BYTES / (1024 * 1024)
        )} MB.`
      );
      return;
    }

    const safeName = sanitizeUploadFilename(doc.file_name, "document.bin");
    const filePath = join(UPLOADS_DIR, `${randomUUID()}_${safeName}`);

    try {
      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer), { mode: 0o600 });

      const caption = ctx.message.caption || `Analyze: ${safeName}`;
      const prompt = `[File: ${filePath}]\n\n${caption}`;

      await saveMessage("user", `[Document: ${safeName}]: ${caption}`);

      const claudeResponse = await callClaude(prompt, { resume: true });
      const cleanResponse = await processMemoryIntents(supabase, claudeResponse);

      await saveMessage("assistant", cleanResponse);
      await sendResponse(ctx, cleanResponse);
    } finally {
      await unlink(filePath).catch(() => {});
    }
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Allowed users: ${TELEGRAM_ALLOWLIST.allowedUserIds.size}`);
console.log(`Allowed chats: ${TELEGRAM_ALLOWLIST.allowedChatIds.size}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
