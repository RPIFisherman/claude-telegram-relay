/**
 * Semantic Search Edge Function
 *
 * Generates an embedding for the query, then calls match_messages or
 * match_memory to find similar rows. This keeps the OpenAI key in Supabase
 * so the relay never needs it.
 *
 * POST body:
 *   { query: string, table?: "messages" | "memory", match_count?: number, match_threshold?: number }
 *
 * Returns: array of matching rows with similarity scores.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) {
      return new Response("SUPABASE_SERVICE_ROLE_KEY not configured", {
        status: 500,
      });
    }

    if (req.headers.get("Authorization") !== `Bearer ${serviceRoleKey}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const {
      query,
      table = "messages",
      match_count = 10,
      match_threshold = 0.7,
    } = await req.json();

    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      return new Response("Missing query", { status: 400 });
    }

    if (normalizedQuery.length > 4000) {
      return new Response("Query too large", { status: 400 });
    }

    if (table !== "messages" && table !== "memory") {
      return new Response("Invalid table", { status: 400 });
    }

    const normalizedMatchCount = Math.min(
      Math.max(Number(match_count) || 10, 1),
      10
    );
    const normalizedThreshold = Math.min(
      Math.max(Number(match_threshold) || 0.7, 0),
      1
    );

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response("OPENAI_API_KEY not configured", { status: 500 });
    }

    // Generate embedding for the search query
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: normalizedQuery,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return new Response(`OpenAI error: ${err}`, { status: 500 });
    }

    const { data } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    // Semantic search via Supabase RPC
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const rpcName = table === "memory" ? "match_memory" : "match_messages";

    const { data: results, error } = await supabase.rpc(rpcName, {
      query_embedding: embedding,
      match_threshold: normalizedThreshold,
      match_count: normalizedMatchCount,
    });

    if (error) {
      return new Response(`Search error: ${error.message}`, { status: 500 });
    }

    return new Response(JSON.stringify(results || []), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
});
