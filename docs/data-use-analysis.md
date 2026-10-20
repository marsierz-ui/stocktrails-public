# Using user data with consent, excluding EU & US - analysis

> NOT legal advice. Engineering/product analysis only. Financial behavioral data
> + cross-border privacy law needs a qualified privacy lawyer before any launch
> or data sale. Treat everything below as a starting framework to take to counsel.

## 0. Two constraints that reshape the plan
1. **"Not EU/US" = exclude those *users*, not just servers.** GDPR Art. 3(2)
   applies to anyone offering services to, or monitoring the behaviour of, people
   in the EU - wherever the company/servers are. US has the FTC + state laws
   (CCPA/CPRA, etc.) with broad reach. Avoiding these regimes means **refusing
   EU/US residents at signup (geofencing)**, not picking a non-EU/US region.
2. **Your current building blocks are US-based.** Google OAuth and Supabase Inc.
   are US processors. "Absolutely not US" conflicts with both. If the constraint
   is strict, you need non-US auth + hosting (see section 6). If it only means
   "don't target US users / don't sell US data," Google+Supabase may be tolerable
   - but that's a legal call, not a technical one.

## 1. What data you actually hold
- **Core:** attention events (ticker, timestamp, source/URL, view counts),
  intraday views, user labels (positive/neutral/negative), derived metrics
  (returns since attention, hit rate, concentration, schedule of activity).
- **Account:** Google identity (email, name), device/usage metadata.
- **Sensitivity:** this is **behavioural + financial-interest data**. Even without
  account balances it reveals what someone trades/watches, when, and their
  conviction. That is high-sensitivity and re-identifiable, which raises the bar
  for both consent and anonymisation.

## 2. Ways the data could be used (each requires matching consent scope)
Ordered roughly low -> high risk:

A. **Product-internal (lowest risk).** Personalisation, your own benchmarks,
   "people who watched X also watched Y" surfaced back to the user. Arguably core
   service; still disclose it.

B. **Aggregate, anonymised insights.** Trending tickers, crowd attention
   heatmaps, sentiment indices - shown in-app or published. Value: engagement,
   marketing. Requires genuine aggregation (thresholds, k-anonymity) so no
   individual is identifiable.

C. **Anonymised/aggregated data products (sold).** Attention & sentiment signals
   to researchers, media, or finance. Highest commercial value. Big caveats:
   - **Re-identification risk** is real for behavioural/financial data; "anonymised"
     often isn't. Needs aggregation, minimum cohort sizes, suppression of rare
     tickers, possibly differential privacy.
   - **Financial/market-data regulation.** Selling crowd trading-attention signals
     can stray into regulated market-data / investment-information territory in
     some jurisdictions. Separate legal axis from privacy.

D. **Research datasets** (academic/partners). Similar to C; consent must name it.

E. **Profiling / advertising (highest risk).** Financial profiling is sensitive
   and the most likely to damage trust and attract regulators. Recommend avoiding
   or treating as strictly separate, explicit, opt-in.

## 3. Consent model (the gate for all of the above)
- **Opt-in, granular, purpose-specific.** Separate toggles for: (i) product
  improvement, (ii) anonymised aggregate publication, (iii) inclusion in sold
  datasets, (iv) any profiling. Collection != use != sharing != sale - each is a
  distinct permission.
- **Revocable** at any time, with a clear effect (stop future use; define whether
  past contributions to aggregates are pulled).
- **Versioned + logged:** store {user, policy_version, scopes, timestamp, method}.
  Re-prompt on material changes.
- **Layered disclosure:** short plain-language summary + full policy.
- **Default off.** Bundling consent into ToS ("use the app = you agree to sell
  your data") is exactly what regulators and users punish; keep it unbundled even
  where a jurisdiction is lax, for trust and future-proofing.

## 4. Jurisdiction strategy
- **Excluding EU/US users:** at signup, combine (a) IP geolocation, (b) declared
  country of residence, (c) ToS prohibiting EU/US use. Block/deny those regions;
  decide your stance on VPNs/edge cases (best-effort is the norm; document it).
  Note geofencing is imperfect - couple it with the residency attestation.
- **"No regulation" is mostly a myth.** Most places you'd actually have users have
  *some* privacy law: Brazil (LGPD), China (PIPL, strict + data-localisation),
  UK (UK-GDPR, i.e. EU-like), Canada (PIPEDA), Australia, India (DPDP Act),
  Switzerland, etc. Strategy is not "lawless" but "**comply locally where your
  users are, avoid the two heaviest enforcers (EU/US)**." Pick target markets,
  then check each.
- **Data residency:** host outside EU/US (e.g. a region in your target market).
  But verify every sub-processor's data flows - auth, hosting, analytics, email,
  the Yahoo proxy - don't let them silently route through EU/US.

## 5. Anonymisation reality check
- Pseudonymisation (drop name/email, keep a per-user id) is **not** anonymisation
  - still personal data, still re-identifiable.
- For published/sold data: aggregate only, enforce **minimum cohort sizes**,
  suppress rare/identifying combinations (small tickers, precise timestamps),
  consider differential privacy for any per-ticker stats. Get a re-identification
  risk assessment before selling.

## 6. The US-stack tension (resolve before building)
If "absolutely not US" is strict:
- **Auth:** Google sign-in = US processing. Alternatives: a non-US-hosted auth
  (self-host an OIDC server, or a provider in your target region), or email-based
  auth. (Users authenticating *with* Google still send data to Google.)
- **Backend:** Supabase Inc. is US; a non-US managed Postgres (e.g. an EU/UK or
  regional provider - but you're excluding EU too) or self-hosted Postgres in the
  target region. This narrows options and is the main cost of the constraint.
- **Decision needed:** is the rule "no US *targeting/sale*" (Google+Supabase may
  be OK) or "no US *processing at all*" (rebuild auth/hosting non-US)? This single
  answer determines the entire stack.

## 7. Other risks
- **Securities/financial-info rules** for selling trading-attention signals
  (separate from privacy; jurisdiction-specific).
- **Breach liability & trust:** financial behavioural data breaches are severe
  reputationally and legally everywhere, regardless of which regime you picked.
- **Reputational/ethical:** "we operate where privacy law is weakest" is a
  narrative competitors/press can use. Strong, transparent consent mitigates it.

## 8. Recommended posture
- Build **consent + scoping infrastructure first** (section 3), default-off, even
  before monetising - it's the foundation and the trust signal.
- **Minimise**: collect/retain only what each consented purpose needs.
- Prefer **B/D (aggregate, anonymised, research)** over **E (profiling/ads)**.
- Treat data **sale (C)** as a deliberate, separately-consented, legally-reviewed
  track with a re-identification assessment - not a default.
- Get the **two strategic answers** (strict vs. soft "no US"; which target
  markets) before writing code, because they pick the stack and the compliance
  checklist.

## 9. Open questions to resolve with counsel / you
1. Strict "no US processing" or just "no US users/sale"? (Determines stack.)
2. Which target markets (countries) will you actually serve? (Determines which
   local privacy laws apply.)
3. Which uses (A-E) do you actually want? (Determines consent scopes + schema.)
4. Sell data, or only use internally + publish aggregates? (Biggest legal delta.)

## 10. Absolute no-go data uses (EU vs US)
Hard red lines (prohibited, or prohibited without strict conditions).

EU (GDPR + ePrivacy):
1. Any processing with **no lawful basis** (Art. 6).
2. **Bundled/forced consent** - conditioning the service on consent to
   non-essential uses (Art. 7(4)); such consent is invalid.
3. **Special-category data** without explicit consent + an Art. 9 exception -
   including special categories *inferred* from behaviour.
4. **Incompatible secondary use** without a new basis (purpose limitation,
   Art. 5(1)(b)) - e.g. silently repurposing "sync" data into a sold dataset.
5. **Selling/sharing to third parties** without specific, informed, granular
   consent + disclosure.
6. **Solely-automated decisions with legal/significant effect** (Art. 22) without
   consent/safeguards - e.g. automated financial profiling that matters.
7. **Reading/storing on the device or cross-site tracking without prior opt-in**
   (ePrivacy) - consent must precede, not follow.
8. **Transfers to non-adequate countries** without safeguards (SCCs).
9. **Ignoring data-subject rights** (access, erasure, objection, portability).
10. **Children's data / marketing to minors** without parental consent.

US (FTC + state + sectoral):
1. **Using/selling data contrary to your own privacy policy** (FTC §5 deception) -
   the primary enforcement hook.
2. **Substantial unjustified consumer harm** (unfairness), incl. dark-pattern
   consent (voided by CPRA).
3. **Collecting from under-13s** without verifiable parental consent (COPPA).
4. **Ignoring CCPA/CPRA opt-outs** - "Do Not Sell or Share," sensitive-PI limit
   (financial info qualifies), no retaliation, honor GPC signals.
5. **Feeding data into credit/insurance/employment/housing eligibility** without
   FCRA compliance (risk of becoming a consumer-reporting agency).
6. **Selling trading/attention "signals" as tailored investment advice** in a way
   that triggers investment-adviser/securities rules without registration.
7. **Intercepting communications** without consent (ECPA/wiretap).

Shared (both): selling/repurposing beyond what was disclosed and consented;
secret collection of sensitive financial data; no deletion path; breach
mishandling.

Contrast: **EU forbids by default** and requires justification + (often) consent
*before* processing; **US is permissive until** you contradict your promises, harm
consumers, hit a sector law (COPPA/FCRA/GLBA/securities), or ignore a state
opt-out.

## 11. Legal use of purposes A-E (EU vs US)
Assumes you choose to serve EU/US users (the opposite of the geofencing strategy
in section 4) - the "if/when you operate there" playbook.

**Master key - genuine anonymisation.** If an output is truly anonymous (judged
against all means reasonably likely to re-identify; GDPR Recital 26), GDPR stops
applying to that output and CCPA exempts it - so B/C/D are low-risk *only if*
anonymisation is real. Pseudonymised (per-user id, name removed) is still
personal/identifiable -> full rules. Behavioural+financial data re-identifies
easily, so this bar is high.

**EU lawful-basis ladder** (use the lightest that fits): contract-necessity (core
service) -> legitimate interest (needs a balancing test + right to object) ->
**consent** (required for sale, marketing, special data).
**US baseline:** disclose accurately (deception is the main trap); honor state
opt-outs for sale/share + sensitive-PI; watch sector laws (COPPA/FCRA/securities).

| Use | EU - legal path | US - legal path |
|---|---|---|
| **A. Product-internal** (personalisation, "watched X->Y" back to user) | Basis = contract-necessity or legitimate interest (document balancing test); privacy notice; minimise; allow objection; no Art. 22 significant automated decisions. No separate consent if core + disclosed. | Disclose in policy. Internal personalisation isn't a sale/share or cross-context ad -> generally allowed. Lowest risk. |
| **B. Aggregate anonymised insights** (in-app/published) | Anonymise robustly (k-anonymity, minimum cohort thresholds; Recital 26). The anonymisation step needs a basis (legitimate interest) + disclosure; anonymous output is then outside GDPR. | Meet CCPA deidentification/aggregate standard + public no-re-identify commitment; disclose; don't overclaim "anonymous." Low risk. |
| **C. Sold data products** | Sell only truly anonymous aggregates -> outside GDPR. Any re-identifiability = sharing personal data -> explicit consent + transparency + buyer contract + transfer rules; likely a DPIA (large-scale behavioural). Document the method. | Deidentified/aggregate -> exempt from sale rules if standard met. If identifiable -> sale/share: opt-out + GPC + disclosure; sensitive-PI limit. Contractually ban buyer re-identification and FCRA/eligibility use. Plus market-data/securities axis. |
| **D. Research datasets** | Art. 89 research regime: pseudonymise/anonymise + safeguards; can be a "compatible" secondary use; name it in the notice; if anonymous, outside GDPR. | Like C: deidentify, data-use agreements, academic IRB where relevant, avoid FCRA uses, disclose. |
| **E. Profiling / advertising** | Highest bar: consent for behavioural ads (ePrivacy + GDPR); absolute right to object to direct-marketing profiling (Art. 21(2)); Art. 22 limits; DPIA. Recommend avoid. | Cross-context behavioural advertising = regulated "sharing": opt-out + GPC; sensitive-PI limit; COPPA if minors; FTC scrutiny on financial profiling. Avoid or strict opt-in. |

**Consent/scope mapping to build:**
- A -> core-service notice (EU: contract/LI; US: disclosure).
- B -> disclosure + anonymisation guarantee.
- C/D -> separate explicit opt-in toggle + buyer contracts + (EU) DPIA.
- E -> its own explicit opt-in + opt-out/GPC plumbing, or drop it.
