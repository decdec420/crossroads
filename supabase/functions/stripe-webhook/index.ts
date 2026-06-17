// Supabase Edge Function: stripe-webhook  (verify_jwt = false; Stripe signs requests)
//
// Verifies the Stripe-Signature header (HMAC-SHA256), then keeps public.subscriptions
// in sync with Stripe. Because mcp_meter resolves a key's quota from the owner's active
// subscription, an upgrade here lifts the hosted-MCP quota automatically — no other change.
//
// Required secrets:  STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const WHSEC = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const PRICE_PRO = Deno.env.get("STRIPE_PRICE_PRO") ?? "";
const PRICE_TEAM = Deno.env.get("STRIPE_PRICE_TEAM") ?? "";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// ==SIG START==  (Stripe webhook signature verification — unit-tested)
async function verifyStripeSig(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts: Record<string, string> = {};
  for (const seg of sigHeader.split(",")) { const i = seg.indexOf("="); if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim(); }
  const t = parts["t"]; const v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute tolerance against replay
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
// ==SIG END==

function priceToPlan(priceId: string): "pro" | "team" | "free" {
  if (priceId && priceId === PRICE_TEAM) return "team";
  if (priceId && priceId === PRICE_PRO) return "pro";
  return "free";
}

// deno-lint-ignore no-explicit-any
async function upsertFromSubscription(sub: any, forceFree = false): Promise<void> {
  const userId = sub?.metadata?.user_id;
  if (!userId) return;
  const priceId = sub?.items?.data?.[0]?.price?.id ?? "";
  await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      plan: forceFree ? "free" : priceToPlan(priceId),
      status: forceFree ? "canceled" : (sub.status ?? "active"),
      stripe_customer_id: sub.customer ?? null,
      stripe_subscription_id: sub.id ?? null,
      current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    },
    { onConflict: "user_id" }
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!WHSEC) return json({ error: "STRIPE_WEBHOOK_SECRET not configured" }, 503);
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSig(body, sig, WHSEC))) return json({ error: "invalid signature" }, 400);

  // deno-lint-ignore no-explicit-any
  let event: any;
  try { event = JSON.parse(body); } catch { return json({ error: "bad json" }, 400); }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await upsertFromSubscription(event.data.object);
        break;
      case "customer.subscription.deleted":
        await upsertFromSubscription(event.data.object, true);
        break;
      // checkout.session.completed is informational here; subscription.* events carry the plan.
    }
    return json({ received: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
