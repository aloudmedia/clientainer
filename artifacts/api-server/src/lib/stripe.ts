import Stripe from "stripe";

export class StripeConfigError extends Error {}

/**
 * Create a Stripe client bound to a workspace's BYO secret key.
 * Each workspace stores its own Stripe credentials, so we don't keep a
 * singleton client.
 */
export function getStripeClient(secretKey: string | null | undefined): Stripe {
  if (!secretKey) {
    throw new StripeConfigError("Stripe secret key is not configured for this workspace");
  }
  // Don't pin apiVersion — let it default to the account's configured version.
  return new Stripe(secretKey, { typescript: true });
}

export interface CheckoutSessionInput {
  amountMinor: number;
  currency: string;
  productName: string;
  productDescription?: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  metadata: Record<string, string>;
  idempotencyKey?: string;
}

export async function createCheckoutSession(
  secretKey: string,
  input: CheckoutSessionInput,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient(secretKey);
  return await stripe.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountMinor,
            product_data: {
              name: input.productName,
              ...(input.productDescription
                ? { description: input.productDescription }
                : {}),
            },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      metadata: input.metadata,
      payment_intent_data: { metadata: input.metadata },
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
  );
}

/**
 * Verifies a Stripe webhook signature against the workspace's signing secret.
 * Throws on invalid/expired signatures. Uses Stripe's own constructEvent helper
 * which handles tolerance and constant-time comparison internally.
 */
export function verifyWebhookEvent(
  secretKey: string,
  rawBody: Buffer,
  signature: string | undefined,
  webhookSecret: string,
): Stripe.Event {
  if (!signature) throw new Error("Missing stripe-signature header");
  const stripe = getStripeClient(secretKey);
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
