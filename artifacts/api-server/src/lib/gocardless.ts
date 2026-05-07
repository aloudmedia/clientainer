import crypto from "node:crypto";

export type GcEnv = "sandbox" | "live";

const BASE_URLS: Record<GcEnv, string> = {
  sandbox: "https://api-sandbox.gocardless.com",
  live: "https://api.gocardless.com",
};

const GC_VERSION = "2015-07-06";

export class GoCardlessError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface GcRequestOpts {
  token: string;
  env: GcEnv;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

async function gcRequest<T>({ token, env, method, path, body, idempotencyKey }: GcRequestOpts): Promise<T> {
  const url = `${BASE_URLS[env]}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "GoCardless-Version": GC_VERSION,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const message = parsed?.error?.message || `GoCardless ${method} ${path} failed with ${res.status}`;
    throw new GoCardlessError(message, res.status, parsed);
  }
  return parsed as T;
}

// ─── Billing Requests (one-off payment via mandate) ──────────────────────────

export interface CreateBillingRequestParams {
  amount: number;        // pence/cents (smallest unit)
  currency: string;      // e.g. "GBP", "EUR", "USD"
  description?: string;
  reference?: string;
  metadata?: Record<string, string>;
}

export interface BillingRequest {
  id: string;
  status: string;
  payment_request?: { amount: number; currency: string; description?: string };
  links?: Record<string, string>;
}

export async function createBillingRequest(
  token: string,
  env: GcEnv,
  p: CreateBillingRequestParams,
  idempotencyKey?: string,
): Promise<BillingRequest> {
  const res = await gcRequest<{ billing_requests: BillingRequest }>({
    token, env, method: "POST", path: "/billing_requests", idempotencyKey,
    body: {
      billing_requests: {
        payment_request: {
          amount: p.amount,
          currency: p.currency,
          description: p.description,
          ...(p.reference ? { reference: p.reference } : {}),
        },
        mandate_request: { currency: p.currency },
        ...(p.metadata ? { metadata: p.metadata } : {}),
      },
    },
  });
  return res.billing_requests;
}

export interface CreateBillingRequestFlowParams {
  billingRequestId: string;
  redirectUri: string;   // user lands here after completing payment
  exitUri: string;       // user lands here if they cancel
  prefilledCustomer?: { email?: string; given_name?: string; family_name?: string };
}

export interface BillingRequestFlow {
  id: string;
  authorisation_url: string;
  links?: Record<string, string>;
}

export async function createBillingRequestFlow(
  token: string,
  env: GcEnv,
  p: CreateBillingRequestFlowParams,
): Promise<BillingRequestFlow> {
  const res = await gcRequest<{ billing_request_flows: BillingRequestFlow }>({
    token, env, method: "POST", path: "/billing_request_flows",
    body: {
      billing_request_flows: {
        redirect_uri: p.redirectUri,
        exit_uri: p.exitUri,
        links: { billing_request: p.billingRequestId },
        ...(p.prefilledCustomer ? { prefilled_customer: p.prefilledCustomer } : {}),
      },
    },
  });
  return res.billing_request_flows;
}

export async function getBillingRequest(
  token: string,
  env: GcEnv,
  id: string,
): Promise<BillingRequest> {
  const res = await gcRequest<{ billing_requests: BillingRequest }>({
    token, env, method: "GET", path: `/billing_requests/${id}`,
  });
  return res.billing_requests;
}

// ─── Webhook signature verification ──────────────────────────────────────────

/** GoCardless signs webhook bodies with HMAC-SHA256 over the raw request body. */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Webhook event types we care about ───────────────────────────────────────

export interface WebhookEvent {
  id: string;
  resource_type: string;     // "billing_requests" | "payments" | ...
  action: string;            // "fulfilled" | "confirmed" | "failed" | ...
  links?: Record<string, string>;
  details?: Record<string, unknown>;
}

export interface WebhookPayload {
  events: WebhookEvent[];
}
