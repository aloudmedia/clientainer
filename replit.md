# Clientainer

Clientainer is a SaaS platform for freelancers and agencies to manage client retainers.

## Run & Operate

- `pnpm run typecheck`: Full typecheck across all packages.
- `pnpm run build`: Typecheck and build all packages.
- `pnpm --filter @workspace/api-spec run codegen`: Regenerate API hooks and Zod schemas from OpenAPI spec.
- `pnpm --filter @workspace/db run push`: Push DB schema changes (development only).

### Required environment / secrets

- `DATABASE_URL`, `SESSION_SECRET`, `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`.
- Platform billing (Stripe-on-Clientainer): `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET`. Per-plan/per-interval price IDs: `PLATFORM_STRIPE_PRICE_BASIC_MONTHLY`, `PLATFORM_STRIPE_PRICE_BASIC_ANNUAL`, `PLATFORM_STRIPE_PRICE_PRO_MONTHLY`, `PLATFORM_STRIPE_PRICE_PRO_ANNUAL`, `PLATFORM_STRIPE_PRICE_AGENCY_MONTHLY`, `PLATFORM_STRIPE_PRICE_AGENCY_ANNUAL`. Legacy `PLATFORM_STRIPE_PRICE_PRO` / `PLATFORM_STRIPE_PRICE_AGENCY` still work as a monthly fallback. Without these, the `/api/platform/checkout` and `/api/platform/portal` routes return 503 — the rest of the app still works.

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (v4), drizzle-zod
- **API Codegen**: Orval
- **Auth**: Clerk
- **Frontend**: React, Vite, Tailwind CSS v4, shadcn/ui, wouter, TanStack Query
- **Build**: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server`: Express API server.
- `artifacts/client-port`: React single-page application (Clientainer).
- `artifacts/client-port/src/pages/landing.tsx`: Public marketing landing (hero, features, retainer types, how-it-works, pricing, CTA). Also exports `MarketingShell` (`activeNav: "features" | "blog" | "knowledge"`) used by all marketing subpages.
- `artifacts/client-port/src/pages/features.tsx`: Public Features page (`/features`) — grouped by Sell / Deliver / Client portal / Operate / Foundations, with detailed cards (icon + description + bullet list) and a closing trial CTA. Linked from the marketing nav and the landing hero "Explore features" button.
- `artifacts/client-port/src/pages/compare.tsx`: Public comparison hub (`/compare`) + per-competitor pages (`/compare/:slug`) for `freshdesk`, `teamwork`, `clickup`. Each page has hero positioning, "why they exist / where they fit / where they miss" framing, "Best for" list, "Where Clientainer pulls ahead" cards, a feature-by-feature table (yes / partial / no with notes), and a CTA. Add new competitors by extending the `COMPARISONS` array. Linked from the footer Compare column.
- The `MarketingShell` footer is a 5-column grid: brand + Instagram/LinkedIn/email socials, Product, Compare, Resources. `MarketingShell.activeNav` accepts `"features" | "blog" | "knowledge" | "compare"`.
- `artifacts/client-port/src/pages/blog.tsx` + `blog-post.tsx`: Public blog index and post detail (`/blog`, `/blog/:slug`), fetched from API.
- `artifacts/client-port/src/pages/knowledge.tsx`: Public knowledge base (`/knowledge`, `/knowledge/:slug`). Static content authored as a `KB_CATEGORIES` array (Getting started, Retainer types, Client portals, Requests, Intake forms, Billing, Email & reminders, Reports, Integrations, Plans). Add new articles by extending the array — index page + sidebar + routes update automatically. Linked from the marketing nav (`MarketingShell` accepts `activeNav: "blog" | "knowledge"`).
- `artifacts/client-port/src/pages/owner/blog.tsx`: Owner blog admin (`/owner/blog`) — list/create/edit/publish/delete.
- `artifacts/api-server/src/routes/blog.ts`: Blog CRUD — public `GET /blog/posts[/{slug}]` (published only) + owner `GET/POST/PATCH/DELETE /owner/blog-posts`.
- `artifacts/api-server/src/routes/requests.ts`: Request CRUD + reply thread — `GET/POST /requests/{id}/messages` and `POST /requests/{id}/mark-read`. Both customer (primary or permitted secondary contact) and workspace admin/owner can read/post; the route auto-stamps the author's `*LastReadAt` and updates denormalized `lastMessageAt`/`lastMessageByRole` on the request. When an admin replies, a best-effort email is sent to the customer via the workspace mailer (`renderRequestReplyEmail` in `lib/email-sender.ts`); failures are logged and never fail the API call. Dashboards (`routes/dashboard.ts`) expose `unreadReplies` so the UI can show a badge.
- `artifacts/client-port/src/components/request-thread.tsx`: Shared chat-style thread (used by both admin & portal request detail dialogs); polls every 30s, marks-as-read on open, supports ⌘/Ctrl+Enter to send. Each message has emoji reactions (`completed ✅`, `smile 😊`, `sad 😞`, `wow 🤩`, `love ❤️`) — hover a bubble to reveal the reaction picker; reactions toggle via `POST /requests/{id}/messages/{messageId}/reactions` (slug emoji only, never raw glyph). Aggregated counts + `mine` flags ride on each `RequestMessage` payload from `GET /messages`.
- `artifacts/api-server/src/routes/topups.ts`: Customer top-ups + customer-initiated **package switching** via `POST /portal/package-purchase`. Switch creates a Stripe Checkout session and a `topupsTable` row with `switchToPackageId` set. On webhook confirmation (`webhooks-stripe.ts` `applyConfirmedTopup`), the active subscription's `packageId` is replaced and `totalMinutes`/`usedMinutes`/`currency` are reset from the new package. Stripe-only (GoCardless not supported for switches).
- `artifacts/client-port/src/pages/portal/packages.tsx`: Portal retainers — non-active cards now show a "Switch to this retainer · $price" button that hits `/portal/package-purchase` and redirects to Stripe; falls back to the old "contact your account manager" copy when the package has no price.
- `artifacts/api-server/src/routes/access-requests.ts`: Public `POST /portal/access-requests` (would-be teammate submits a request to join a client portal as a secondary contact) + admin `GET /access-requests`, `POST /access-requests/{id}/approve|decline`. Approval idempotently creates a `secondary_contacts` row.
- `artifacts/api-server/src/lib/clerk-invite.ts`: Helper that creates a Clerk invitation and emails the activation link. If the workspace has Gmail/SMTP configured (`email_settings`), Clerk is asked NOT to send (`notify:false`) and the link is delivered via the workspace's own transport using `lib/email-sender.ts`. If workspace email isn't configured (or sending fails), Clerk's default email is used as fallback. Used by `POST /users` (best-effort on create) and `POST /users/{id}/invite` (admin resend).
- `artifacts/api-server/src/lib/email-sender.ts`: Builds a nodemailer transport from a workspace's `email_settings` (Gmail app-password or SMTP) and exposes `getWorkspaceMailer()` + `renderInviteEmail()`.
- `artifacts/client-port/src/pages/request-access.tsx`: Public "Request access" form (`/request-access?slug=…`).
- `artifacts/client-port/src/pages/admin/access-requests-panel.tsx`: Pending-requests widget shown atop the admin Clients page.
- `lib/api-spec/openapi.yaml`: OpenAPI specification (API source-of-truth).
- `lib/db/schema.ts`: Drizzle ORM database schema definition.
- `artifacts/client-port/src/pages/admin/reports.tsx`: Admin Reports — KPIs (clients, requests, hours used, spend), activity/spend time series (recharts), and per-client table. Backed by `GET /api/reports/admin?range=7d|30d|90d|365d` (`artifacts/api-server/src/routes/reports.ts`). Burn rate = sum of `requests.usedMinutes` (created in range) / days.
- `artifacts/client-port/src/pages/admin/settings.tsx`: Admin settings (General/Appearance/Billing/Payments/Integrations/Email/Plugins tabs).
- `artifacts/client-port/src/pages/admin/billing-panel.tsx`: Workspace plan + Stripe Checkout/Portal UI.
- `artifacts/client-port/src/pages/owner/subscriptions.tsx`: Platform owner subscriptions overview.
- `lib/db/src/plans.ts`: Plan definitions (Free/Professional/Agency), limits, and `isWithinLimit` helper.
- `artifacts/api-server/src/lib/platform-stripe.ts`: Lazy platform-Stripe client + checkout/portal/verifyWebhook.
- `artifacts/api-server/src/lib/plan-guards.ts`: `requirePlanCapacity` middleware + `getCurrentUsage` helper.
- `artifacts/api-server/src/routes/platform-billing.ts`, `routes/webhooks-platform-stripe.ts`: Platform billing routes.

## Architecture decisions

- **Multi-tenancy**: Implemented with workspace slugs in URLs (`/{slug}`).
- **Role-based Access**: Clerk integration with custom middleware for `owner`, `admin`, `customer` roles.
- **API Codegen**: OpenAPI spec drives frontend API hooks and Zod schemas for type safety and consistency.
- **Payment Processor Abstraction**: Supports Stripe and GoCardless via a common interface, with workspace-specific configurations.
- **Modular Frontend Layouts**: Separate layouts for Customer Portal, User Admin, and Owner Admin to manage distinct functionalities and access levels.

## Product

- **Retainer Management**: Create and manage prepaid, ongoing, unlimited, bundle, and credits-based retainers.
- **Client Portals**: Login-gated portals (no public storefront) where customers view their assigned retainer, balances, and submit requests. The public package list remains available via the WordPress embed (`/embed/:slug`) only.
- **Admin Dashboards**: Comprehensive admin interfaces for managing clients, packages, requests, intake forms, and style settings.
- **Custom Intake Forms**: Drag-and-drop form builder with dynamic fields assigned per client.
- **Automated Reminders**: Configurable low-balance and expiry reminders for subscriptions.
- **Flexible Billing**: Hourly rate overrides, custom billing cycles, and minimum request hours per subscription.
- **Payment Processing**: Integrations for Stripe and GoCardless for customer top-ups.
- **AI-Powered Description Generation**: AI assistant for generating request descriptions.
- **Transactional Email Customization**: Workspace-specific email templates for various events.
- **WordPress Integration**: Public API and WordPress plugin for lead capture and public package display.
- **Platform Subscriptions**: Three publicly-offered paid plans, no self-serve free tier — every signup gets a 14-day trial. Solo (plan id `basic`, $12/user/mo annual or $15 monthly), Professional ($25/user/mo annual or $29 monthly), Agency ($54/mo annual or $69 monthly, flat workspace price — not per-user). Per-user pricing is currently displayed only; Stripe checkout uses `quantity: 1` (seat scaling is a future enhancement). Plan limits enforced server-side (clients, retainers, requests/month, integrations, multi-admin, reports, ai); over-limit creates return HTTP 402 with `{ currentPlan, requiredPlan, limit, current }`. Owners get a `/owner/subscriptions` overview with per-workspace MRR + usage and a "Change plan" action per row. The `free` plan id is reserved for **owner-granted comp accounts** — it is hidden from the public pricing UI and the in-app billing panel (filtered via `PUBLIC_PLAN_IDS` in `lib/db/src/plans.ts`) but grants full Agency-tier capabilities (all limits null/true) with no billing. Comp can only be assigned via `POST /owner/workspaces/{slug}/plan` from the Owner admin; setting a workspace to `free` also clears its `platformStripeSubscriptionId` / status / period-end so the workspace is "clean" of any prior subscription record. **Note**: the `reports` and `ai` plan booleans are exposed in the API and drive UI gating on the marketing/billing cards, but `/api/reports/*` and the AI description endpoint are not yet hard-gated server-side — that's a planned follow-up.

## User preferences

_Populate as you build_

## Gotchas

- Workspace-scoped API endpoints require the `X-Workspace-Slug` header.
- Customers (`users.role='customer'`) are scoped to a single workspace via `users.workspaceId`. The column is nullable for legacy rows; an orphan customer (workspaceId=NULL) will never appear in any admin's `GET /users` list. Stamp `workspaceId` on all new customer creation paths.
- `POST/PUT /api/packages` require `groupId` to belong to the current workspace.
- Timer for `credits` packages is disabled; credits must be logged manually.
- Credit-hour updates for subscriptions are idempotent.
- New admins are redirected to `/onboarding` to create a workspace.
- The platform-Stripe webhook (`POST /api/webhooks/platform-stripe`) needs the raw request body and is mounted before `express.json()` in `app.ts`. Do not move it.
- The portal sign-in page swaps Clerk's "Sign up" link for `/request-access` only when the redirect target looks like a portal (`/{slug}`, not `/{slug}/admin`, `/owner`, etc.). See `isPortalRedirect` in `App.tsx`. New agency owners coming from the marketing site still hit Clerk SignUp normally.
- `workspace_plan` enum values are `free | professional | agency` (renamed from `free | starter | pro`). Re-running `db push` after enum changes may require `--force`.
- Creating a customer (`POST /users`) sends a Clerk invitation email best-effort; failures are logged but do NOT fail the request. Admins can resend via `POST /users/{id}/invite` (the "Resend" button on rows with an "Invite sent" badge). Clients with `clerkUserId` starting with `pending:` are not yet activated; the row links to the real Clerk account on first sign-in via `/users/sync` (email match).

## Pointers

- [Clerk Documentation](https://clerk.com/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/docs)
- [React Query Documentation](https://tanstack.com/query/latest/docs/react/overview)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Orval Documentation](https://orval.dev/)