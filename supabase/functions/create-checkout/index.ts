// Supabase Edge Function: create-checkout  (verify_jwt = true; signed-in users only)
//
// Creates a Stripe Checkout Session for a plan and returns its URL. The subscription is
// tagged with metadata.user_id so the webhook can attribute it back to the user.
//
// Required secrets:  STRIPE_SECRET_KEY, STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM, APP_URL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SECRET = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const PRICE: Record<string, string> = { pro: Deno.env.get("STRIPE_PRICE_PRO") ?? "", team: Deno.env.get("STRIPE_PRICE_TEAM") ?? "" };
const APP_URL = Deno.env.get("APP_URL") ?? "https://neuronautworld.netlify.app";

const CORS: Record<string, string> = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!SECRET) return json({ error: "Stripe not configured (STRIPE_SECRET_KEY unset)" }, 503);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { plan } = await req.json().catch(() => ({ plan: "" }));
  const priceId = PRICE[plan];
  if (!priceId) return json({ error: `unknown or unconfigured plan '${plan}' (expected 'pro' or 'team')` }, 400);

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${APP_URL}/?billing=success`);
  form.set("cancel_url", `${APP_URL}/?billing=cancel`);
  form.set("client_reference_id", user.id);
  form.set("customer_email", user.email ?? "");
  form.set("metadata[user_id]", user.id);
  form.set("subscription_data[metadata][user_id]", user.id);
  form.set("allow_promotion_codes", "true");

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  // deno-lint-ignore no-explicit-any
  const s: any = await r.json();
  if (!r.ok) return json({ error: s?.error?.message ?? "stripe error" }, 502);
  return json({ url: s.url, id: s.id });
});
