# Stripe billing — setup checklist

The billing infrastructure is built and deployed. Plans drive the hosted-MCP quota
automatically: `mcp_meter` resolves a key's effective plan from the owner's active
subscription, so an upgrade lifts the limit with no other change.

| Edge function | Auth | Purpose |
|---|---|---|
| `create-checkout` | Supabase JWT (signed-in user) | Returns a Stripe Checkout URL for `pro` / `team` |
| `stripe-webhook` | Stripe signature (HMAC-SHA256, verified) | Upserts `public.subscriptions` on subscription events |

Both are live and return a clean **503 "not configured"** until the secrets below are set — no redeploy is needed once you add them.

## 1. Create products in Stripe
Create two recurring **Prices** (e.g. Pro and Team) and copy their `price_…` IDs. Start in **test mode** (`sk_test_…`, test price IDs).

## 2. Set Supabase function secrets
Dashboard → Project → Edge Functions → Secrets, or CLI:
```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_PRICE_PRO=price_xxx \
  STRIPE_PRICE_TEAM=price_yyy \
  APP_URL=https://neuronautworld.netlify.app
# STRIPE_WEBHOOK_SECRET is added in step 3
```

## 3. Register the webhook in Stripe
Add an endpoint pointing at:
```
https://rgbgstcipidkrcjofins.supabase.co/functions/v1/stripe-webhook
```
Subscribe to events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the endpoint's **signing secret** (`whsec_…`) and set it:
```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## 4. Wire the app
From the signed-in web app, call `create-checkout` and redirect:
```js
const { data:{ session } } = await supabase.auth.getSession();
const r = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout`, {
  method:"POST",
  headers:{ Authorization:`Bearer ${session.access_token}`, "Content-Type":"application/json" },
  body: JSON.stringify({ plan:"pro" })
});
const { url } = await r.json();
window.location = url;            // → Stripe Checkout
```
On success Stripe fires the webhook → the subscription is upserted → the user's API keys immediately resolve to the higher quota.

## 5. Test it (Stripe CLI)
```bash
stripe listen --forward-to https://rgbgstcipidkrcjofins.supabase.co/functions/v1/stripe-webhook
stripe trigger customer.subscription.updated
```
Verify a row appears/updates in `public.subscriptions`, then call the hosted MCP with that owner's key — quota should reflect the new plan.

## Verified already
- Webhook signature verification (valid accepted; tampered / wrong-secret / stale / garbage rejected) — unit-tested.
- Subscription → quota resolution (`pro` ⇒ 10,000/mo) — tested against the live DB.
