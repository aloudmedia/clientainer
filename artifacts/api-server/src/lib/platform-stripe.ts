import Stripe from "stripe";
import { PLANS, type PlanId, type BillingInterval } from "@workspace/db";

export class PlatformStripeConfigError extends Error {}

// Legacy single-price env vars — used as a fallback for the monthly price on
// the Pro and Agency plans so existing Stripe configurations keep working.
const LEGACY_PRICE_FALLBACKS: Partial<Record<PlanId, string>> = {
  professional: "PLATFORM_STRIPE_PRICE_PRO",
  agency: "PLATFORM_STRIPE_PRICE_AGENCY",
};

let cachedClient: Stripe | null = null;

/**
 * Returns a Stripe client for the platform's own billing account (used to
 * subscribe agencies to Free/Professional/Agency plans). Distinct from the
 * per-workspace BYO Stripe used for customer top-ups.
 */
export function getPlatformStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.PLATFORM_STRIPE_SECRET_KEY;
  if (!key) {
    throw new PlatformStripeConfigError(
      "PLATFORM_STRIPE_SECRET_KEY is not configured",
    );
  }
  cachedClient = new Stripe(key, { typescript: true });
  return cachedClient;
}

export function getPlatformWebhookSecret(): string {
  const secret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new PlatformStripeConfigError(
      "PLATFORM_STRIPE_WEBHOOK_SECRET is not configured",
    );
  }
  return secret;
}

export function getPriceIdForPlan(planId: PlanId, interval: BillingInterval = "month"): string {
  const plan = PLANS[planId];
  const envVar = interval === "year" ? plan.stripePriceAnnualEnvVar : plan.stripePriceMonthlyEnvVar;
  if (!envVar) {
    throw new PlatformStripeConfigError(
      `Plan "${planId}" is not a paid plan and has no Stripe price`,
    );
  }
  const priceId =
    process.env[envVar] ??
    (interval === "month" ? process.env[LEGACY_PRICE_FALLBACKS[planId] ?? ""] : undefined);
  if (!priceId) {
    throw new PlatformStripeConfigError(
      `${envVar} is not configured`,
    );
  }
  return priceId;
}

export interface PlatformCheckoutInput {
  workspaceId: number;
  workspaceSlug: string;
  planId: PlanId;
  interval?: BillingInterval;
  customerEmail?: string;
  existingStripeCustomerId?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export async function createPlatformCheckoutSession(
  input: PlatformCheckoutInput,
): Promise<Stripe.Checkout.Session> {
  const stripe = getPlatformStripe();
  const interval: BillingInterval = input.interval ?? "month";
  const priceId = getPriceIdForPlan(input.planId, interval);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: String(input.workspaceId),
    subscription_data: {
      trial_period_days: 14,
      metadata: {
        workspaceId: String(input.workspaceId),
        workspaceSlug: input.workspaceSlug,
        planId: input.planId,
        interval,
      },
    },
    metadata: {
      workspaceId: String(input.workspaceId),
      workspaceSlug: input.workspaceSlug,
      planId: input.planId,
      interval,
    },
  };

  if (input.existingStripeCustomerId) {
    params.customer = input.existingStripeCustomerId;
  } else if (input.customerEmail) {
    params.customer_email = input.customerEmail;
  }

  return await stripe.checkout.sessions.create(params, {
    idempotencyKey: `platform-checkout-${input.workspaceId}-${input.planId}-${interval}-${Date.now()}`,
  });
}

export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getPlatformStripe();
  return await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export function verifyPlatformWebhookEvent(
  rawBody: Buffer,
  signature: string | undefined,
): Stripe.Event {
  if (!signature) throw new Error("Missing stripe-signature header");
  const stripe = getPlatformStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, getPlatformWebhookSecret());
}
