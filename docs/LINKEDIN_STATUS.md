# LinkedIn Status — Audit Statement (v0.4.0)

This is an audit statement, not a feature announcement. It records what
LinkedIn's official APIs actually permit for an app like FlowPilot, what
FlowPilot therefore does **not** do, and what would be required before
anything here could change. No LinkedIn automation has been built.

## What LinkedIn's official APIs permit (as applicable to this app)

LinkedIn's developer platform is a permission-gated, use-case-reviewed
platform. The relevant facts for FlowPilot:

- **Identity and organization data only where granted.** The Sign In with
  LinkedIn / OpenID Connect product returns basic profile data for the
  *authenticated user* who consents, and organization APIs return data for
  organizations the authenticated user administers — each only after the
  corresponding product/permission is approved for the app.
- **Access is per-product and reviewed.** Permissions are granted per
  LinkedIn product (e.g. Sign In, Share on LinkedIn, Marketing Developer
  Platform), and several products require LinkedIn review and approval of
  the specific use case before they work beyond the developer's own test
  scope. Unapproved products return no data.
- **No general-purpose people/company search.** There is no official API
  that lets a third-party app search LinkedIn's member or company directory
  to build prospect lists. People Search and similar capabilities are not
  available to general developer apps.
- **No programmatic messaging to arbitrary members.** The Messaging APIs
  available to approved partners are narrow (e.g. specific partner
  integrations); there is no general API for sending LinkedIn messages or
  InMail from an automation app to people who have not engaged with it.
- **No automated connection requests.** Sending connection invitations
  programmatically is not an available API capability for third-party
  automation apps, and automating connection growth is prohibited by
  LinkedIn's platform terms.
- **Scraping is prohibited.** Collecting member or company data from
  LinkedIn pages outside the official APIs violates LinkedIn's User
  Agreement and platform terms, regardless of the tooling used. FlowPilot
  does not scrape LinkedIn and must never be pointed at it.

LinkedIn's terms and product availability change; before relying on any
specific permission, verify it against LinkedIn's current developer
documentation and the app's own approved products in the LinkedIn Developer
Portal.

## What is UNSUPPORTED and disabled in FlowPilot

The following are explicitly **not** built, not configurable, and not
available through any FlowPilot route, workflow, or campaign channel:

- ❌ LinkedIn messaging (including InMail) from FlowPilot.
- ❌ Automated connection requests or connection-growth automation.
- ❌ Prospect extraction from LinkedIn (search, profile harvesting,
  company/member directory building) via any means, API or otherwise.
- ❌ Any LinkedIn campaign channel. There is no `linkedin` channel in the
  campaign system, and none may be added without the approvals below plus
  a dedicated review of LinkedIn's terms for that exact use case.
- ❌ Scraping LinkedIn pages, or importing data scraped from LinkedIn.
  Prospect imports must come from sources the workspace has a right to use;
  data of LinkedIn origin obtained outside LinkedIn's APIs is not acceptable
  input to the prospecting system.

Prospecting in FlowPilot (see `docs/PROSPECTING.md`) therefore covers only
user-entered data, lawful imports from other sources, and — once configured
in a future release — licensed business-data providers. LinkedIn is not one
of those sources.

## What approval / product access would be required

Before any LinkedIn integration could even be scoped, all of the following
would be needed, and each is a decision for the workspace owner, not
something FlowPilot can grant:

1. **A LinkedIn developer app** owned by the workspace, with verified
   company association where LinkedIn requires it.
2. **Product approval from LinkedIn** for the exact product(s) used (at
   minimum Sign In with LinkedIn / OpenID Connect for identity), with the
   use case reviewed and approved by LinkedIn.
3. **Member consent, per person, per permission.** Any data read would be
   limited to what the consenting member (or administered organization)
   granted, and only for the approved use case.
4. **Compliance review** of LinkedIn's current API terms, User Agreement,
   and rate/usage limits for the specific integration — including a
   written determination that the planned use does not involve messaging
   automation, connection automation, or directory extraction, which the
   official APIs do not support for this kind of app.
5. **A dedicated FlowPilot implementation + audit pass** (OAuth, token
   storage, scope handling, honest capability labeling), delivered as its
   own reviewed change — not bolted onto prospecting.

Until all five exist, the correct LinkedIn status in FlowPilot is the one
stated here: **unsupported and disabled**, by design.
