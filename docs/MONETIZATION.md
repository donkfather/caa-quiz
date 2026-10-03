# How access works (monetization)

From version 1.1 the app has **no ads**. Every device gets a **5-day free
trial** with full access. After that, a full-screen lock screen blocks the app
until the user buys a **one-time unlock** (no subscription) or restores one.
The unlock is the **same store product** that used to remove ads, so everyone
who bought "Elimină reclamele" is unlocked automatically and never sees the
lock screen.

Promo codes (vouchers) are gone. Only test codes were ever issued;
`supabase/migrations/20261002000001_retire_vouchers.sql` drops their tables
and functions, and keeps `forget_device()` reduced to deleting question
reports (see *Why "Șterge toate datele" does not reset the trial*).

## The four states

```
            tap "Începe perioada gratuită"         5 days pass
   new  ───────────────────────────────────▶  trial  ─────────────▶  expired
 (intro)                                     (the app)            (lock screen)

   unlocked  ◀── from any state: buy, restore, or an old "remove ads" purchase
   (the app)
```

| State | When | The user sees |
|---|---|---|
| `new` | No trial recorded on this device or on the server | `TrialIntro`, once: trial length, what locks when it ends, the price, and *Începe perioada gratuită* / *Cumpără acum* / *Am cumpărat deja — Restaurează achizițiile* |
| `trial` | A trial is recorded and has not ended | The app. Settings → *Acces* shows the days left. |
| `expired` | The trial has ended | `Paywall`: buy, a prominent *Restaurează achizițiile*, and *Șterge toate datele* (Settings can't be reached any more). Streak reminders are cancelled (`AccessContext.tsx`) and come back on unlock. |
| `unlocked` | The store says this account owns the unlock | The app, with no trial and no lock screen |

Existing users who update get the intro on their first launch of 1.1, so
their 5 days start when they tap the button. New users are the same.

## Where each rule lives

| Rule | Lives in | Why there |
|---|---|---|
| Who has paid | App Store / Google Play, read through RevenueCat entitlement **`no_ads`** (`src/lib/purchases.ts`) | Only the store knows. A purchase follows the store account, not the phone. |
| When this device's trial started | `public.trials` in Supabase, one row per device: sha256 of the device key, start time, platform. Written only by `start_trial`, which inserts if absent and never moves an existing start. A trial started offline is registered later with its local start (`p_started_at`), which the server clamps to *[now − 5 days, now]*. | A row the app cannot change survives reinstalling, wiping data and changing the clock. |
| How long a trial is | `public.trial_length()` = `interval '5 days'` | Defined once. The app's `TRIAL_DAYS = 5` (`src/lib/accessCore.ts`) is only used when the server can't be reached, and must match. |
| How the inputs combine | `resolveAccess()` in `src/lib/accessCore.ts` — no React Native imports, tested with `npm test` | The rules can be tested without a phone. |
| Device key | `src/lib/deviceKey.ts`: Android → the app-scoped Android ID (survives reinstall). iOS → a random key in the Keychain (survives deleting the app). | Neither is the advertising ID. Only the hash ever reaches the database. |
| Gathering inputs, caching, timeouts | `src/lib/access.ts` (cache in AsyncStorage key `access_v1`) | One place that talks to the network. |
| Recognizing a past buyer after a reinstall | `maybeSyncPurchases()` in `src/lib/access.ts` → `syncUnlockSilently()` in `src/lib/purchases.ts` (`Purchases.syncPurchasesForResult()`), at most once per install (flag `rc_synced_v1`) | A reinstall gets a new anonymous RevenueCat user that doesn't see the old purchase until the receipt is re-sent. See *Silent purchase sync* below. |
| Price shown before buying | The store's own `priceString` from the current offering (`getUnlockPriceString()`), last value cached in `unlock_price_v1` for when the store can't be reached | Never a hardcoded or computed price: the store's string is local currency, VAT included. With nothing ever loaded, the screens say the price is shown in the store before confirming. |
| Test-only tools (expire the trial) | `DEV_TOOLS_ENABLED` in `src/lib/buildFlags.ts` | Two locks — see *Store policy notes → no hidden features*. |
| Which screen shows | `AccessProvider` (`src/lib/AccessContext.tsx`) in `app/_layout.tsx`, re-checked every time the app comes back to the foreground, and whenever RevenueCat reports a CustomerInfo change (`watchStorePurchases()` in `access.ts`) | One gate in front of every screen; an expiry is noticed when the app is reopened days later, and a purchase that settles while the paywall is open (Ask to Buy, a pending payment, a purchase on another device) unlocks it at once. |

## How the decision is made

`resolveAccess()` combines four things: what the device remembers, what
RevenueCat says (*yes*, *no* or *unknown*), what the server says (a trial
start, *no trial*, or *unreachable*), and the old `adsDisabled` setting from
the ad-supported version (only a purchase ever set it).

1. **Unlocked** if RevenueCat says *yes*. If RevenueCat can't be reached,
   whoever was unlocked before stays unlocked, and so does anyone with the old
   `adsDisabled` flag. Only a definite *no* removes an unlock (a refund).
2. **"Now"** (`advanceClock()`): when the server answers, its clock. Offline,
   the last known "now" plus however far the device clock has moved
   *forward* since the last check. A clock wound back adds nothing at that
   check and becomes the new starting point, so real time keeps counting
   from there: setting the phone's clock back neither revives an ended trial
   nor pauses a running one, online or offline.
3. **The trial end** is the *earliest* of what the device remembers and what
   the server has, and — whenever the server's clock is known — never more
   than 5 days after it. Neither a reinstall (fresh device, old server row),
   an offline start (local start, no server row yet) nor a start on a clock
   set forward can lengthen a trial.
4. No trial anywhere → `new`. Before the end → `trial`. Otherwise → `expired`.

## Offline

| Situation | What happens |
|---|---|
| First launch with no internet | The intro shows. *Începe* starts the trial on the device; the next time the app reaches the server it records it there **with the local start time** (clamped by the server to the last 5 days), so a trial that already ran offline is recorded as over and a reinstall gets no new one. The earlier end still wins. |
| Trial running, no internet | Counts down by how far the device clock moves forward between checks. Winding the clock back doesn't pause it; only the moment between the last check and the rewind goes uncounted. |
| Paid user, no internet | Stays unlocked: a known unlock is never taken away by "unknown". |
| Paid user on a fresh install, online | RevenueCat first says *no* (new anonymous user). The app then runs the silent sync once, before showing anything, and goes straight from the splash screen to the app. No password prompt. |
| Paid user on a fresh install, no internet | Sees the intro until RevenueCat can be reached; the silent sync runs on the first check that reaches it — a later return to the foreground or store update in the same process (at most every 30 s), or the next launch. It is only marked done once it completes. *Restaurează achizițiile* also fixes it. |
| Purchase pending (Ask to Buy, slow payment method) | The alert says it unlocks after confirmation, and it does: RevenueCat's CustomerInfo listener unlocks the open paywall the moment the store settles it. |
| Android: buyer taps *Deblochează* while this install doesn't see the purchase yet | Play answers "already owned"; the app re-sends the receipt silently and unlocks. If that fails, it points to *Restaurează achizițiile* instead of saying the purchase failed. |
| Refund | Picked up the next time RevenueCat answers; the user falls back to `trial` or `expired` by dates. |

Every network call has a timeout (RevenueCat 5 s, Supabase 6 s), so a dead
network never leaves the user on the splash screen. The silent sync adds at
most one more 5 s, once per install and only after RevenueCat has answered a
definite *no*; it overlaps the Supabase call, so the worst case on that one
launch is ~10 s of spinner (the splash itself is capped at 4 s).

## Silent purchase sync (reinstalled past buyers)

RevenueCat identifies this app's users by an anonymous app user id that is
created on first launch and lost on reinstall. A past buyer who reinstalls is
therefore a new RevenueCat user whose entitlement reads *no* until the store
receipt is sent again. Without help they would see the trial intro (or, if the
device's trial already ran, the paywall) and have to find *Restaurează
achizițiile* — on iOS that also asks for their Apple ID password.

`refreshAccess()` handles this once per install:

- **When:** RevenueCat answered a definite *no* (not *unknown*), the device
  holds no unlock (`access_v1.unlocked` is false and nothing was bought in this
  process), and the flag `rc_synced_v1` is not set.
- **What:** `Purchases.syncPurchasesForResult()` (the non-deprecated form of
  `syncPurchases`), with the same 5 s timeout as the entitlement check. It
  re-sends the store's receipts without prompting for credentials. Its answer
  replaces the *no*.
- **Flag:** set only when the sync completed (found or not). An error or
  timeout leaves it unset, so a later refresh in the same process (back to
  the foreground, a CustomerInfo update) tries again once `SYNC_RETRY_MS`
  (30 s) has passed, and so does the next launch. A buyer whose single
  attempt hit a flaky connection is therefore not left on the paywall until
  the OS kills the app.
- **Never** `restorePurchases()` automatically: on iOS it can prompt for the
  Apple ID. Restore stays a button (intro, paywall, Settings).
- **No flash:** the gate shows the splash / spinner while the state is `null`,
  and an empty cache (a fresh install) is never primed — so the first state a
  past buyer sees is `unlocked`.

This relies on RevenueCat's **Restore behavior = "Transfer to new App User
ID"** (Project settings) — the default. With "Keep with original App User ID"
the sync would not move the purchase to the new anonymous user.

The scenario tests (`test/access/access.scenarios.test.mjs`) cover a
reinstalled buyer, a sync that finds nothing, an error (not flagged, retried
after the back-off and on the next launch), a rejected first sync that
unlocks on a later resume, a hang (bounded) and the cases where it must not
run.

## Payers don't send the device key

A device whose cache already says *unlocked* waits for RevenueCat before
calling `get_trial`, and skips it when the answer is *yes*. Everyone else asks
both in parallel, so nobody waits for the sum of the two timeouts. The
privacy policy describes this check (every launch and return to the
foreground, before the trial starts too, stops once unlocked and confirmed).

## Why the entitlement id stays `no_ads`

The app asks RevenueCat "is entitlement `no_ads` active?". RevenueCat answers
from the products attached to that entitlement, and every past buyer's
purchase is attached to it. Renaming it in the app alone would unlock nobody;
renaming it in the dashboard would make the still-installed old versions stop
recognizing their buyers (ads would come back for people who paid). **Never
rename the identifier.** Display names — the product's, the offering's, the
entitlement's description — can change freely; users never see the id.

## Why "Șterge toate datele" does not reset the trial

The wipe (`src/lib/dataReset.ts`) does two things:

1. **Server:** calls `forget_device(p_device_id)` with this install's random
   question-report id (best-effort, 5 s timeout, errors ignored; skipped when
   the install never reported anything). The function now deletes **only**
   `public.question_reports` rows for that id — it no longer touches vouchers
   and it never touches `public.trials`. Old 1.0.x clients call the same
   function from their own wipe button with the same kind of id, so it keeps
   working for them too.
The button is in Settings and — because Settings is behind the lock — also on
the lock screen (`LegalLinks withWipe` in `Paywall.tsx`); both use
`useWipeDataFlow()` (`src/components/useWipeDataFlow.ts`). RevenueCat's own
local storage (its anonymous id and cached CustomerInfo, in UserDefaults /
SharedPreferences) is not touched; the privacy policy says so.

2. **Device:** removes every AsyncStorage key **except** the four that decide
   access (`KEPT_ON_WIPE`): `access_v1` (trial end, unlock verdict, clock
   guard), `trial_device_key_v1` (the device-key mirror), `rc_synced_v1` (silent
   sync done) and `unlock_price_v1` (last store price). The report id is
   removed, so the next report gets a new one.

It deliberately leaves the device key (Keychain / Android ID), the access
cache and the server's trial row alone; otherwise "delete all data" would be a
"free trial again" button, or would lock an offline payer out. The row holds
only a hash, a start time and the platform. The privacy policy states all of
this, with legitimate interest (enforcing the offer's terms) as the legal
basis, and says reports are deleted by the button (or by email if the device
was offline at the time).

## What it does not stop (accepted)

- **Factory reset or a new phone** gives a new trial: the Android ID changes on
  factory reset; erasing an iPhone erases its Keychain. (Restoring an iPhone
  backup may carry the key over.)
- **iOS Keychain keeping items after the app is deleted** is how iOS behaves
  today, not something Apple promises. If that changes, deleting and
  reinstalling becomes a new trial on iOS.
- **A reinstall that never goes online** keeps a device-only trial until the
  device reaches the server. The question bank is bundled, so this is
  possible, but rare.
- **Winding the clock back before every launch, while never going online.**
  Each rewind costs the trial only the time since the previous check, so
  someone who sets the clock back by exactly the elapsed time before every
  single launch, and keeps the app off the network, stretches the trial. The
  first server answer ends it. A one-off rewind buys nothing.
- **Moving the clock forward by mistake while offline** ends the trial early
  until the app next reaches the server, whose clock then applies again.

The price is small and the target is honest people forgetting to pay, not a
determined attacker. Closing these would need accounts or device attestation,
which cost more than they protect.

## Testing

- **Tests:** `npm test` runs the unit tests for the rules
  (`src/lib/accessCore.test.ts`) and the scenario tests for the stateful side
  (`test/access/*.test.mjs`: `access.ts` and `dataReset.ts` against in-memory
  stubs of AsyncStorage, RevenueCat and Supabase — see
  `test/access/register.mjs`).
- **The intro:** a fresh install on a device that never started a trial.
- **The lock screen:** in a dev or preview build, Settings → *Expiră perioada de
  probă (dev / preview)* (shown while a trial is running). It sticks until the
  app is reinstalled (*Șterge toate datele* keeps the access cache, so it no
  longer undoes it); then the server's real remaining trial applies again.
- **A reinstalled past buyer:** with a sandbox / licence-tester account that
  owns the unlock, delete the app, reinstall, launch online: it must open
  straight into the app with no password prompt (silent sync).
- **Buying and restoring** only work in store builds (TestFlight sandbox, Play
  internal testing with a licence tester): preview builds carry no RevenueCat
  key. A preview build whose trial really ended stays on the lock screen.
- **A fresh server trial for a test device:** delete its row from
  `public.trials` in the Supabase SQL editor (find it by `started_at` and
  `platform`; the key itself is only stored hashed).

## Release checklist (manual, first release of the trial model)

Work through it in order. Each step says how to check it.

### 1. Database — before any 1.1 build reaches anyone

- [ ] Apply both migrations to project `heuooollkwoksqfncvoc` **by hand**, in
      this order, with the SQL editor (or `psql -f`, or the Supabase MCP
      `apply_migration`). **Not** `supabase db push`: the project was built by
      hand and its recorded migration history uses different version ids from
      the files here, so push refuses to run — and the CLI's suggested fix,
      `supabase migration repair --status reverted …`, would make the next
      push replay every older file in this folder onto production, undoing
      later hardening (e.g. `fn_set_updated_at`'s `search_path`). Never run
      `migration repair` + `db push` against this project. (To make push usable
      one day: `supabase migration fetch` first, then mark the repo-only
      versions `--status applied`.)
      1. `supabase/migrations/20261002000000_trials.sql`
      2. `supabase/migrations/20261002000001_retire_vouchers.sql` (drops the
         voucher tables — test codes only — and redefines `forget_device()` to
         delete question reports only)
- [ ] Check the read RPC works with the public key:
      ```sh
      curl -s https://heuooollkwoksqfncvoc.supabase.co/rest/v1/rpc/get_trial \
        -H "apikey: $EXPO_PUBLIC_SUPABASE_KEY" -H "Content-Type: application/json" \
        -d '{"p_device_key":"release-check-0000"}'
      # expect {"exists": false, ..., "server_now": "..."}
      ```
- [ ] Check the table itself is closed: the same key on
      `/rest/v1/trials?select=*` must be refused, not return rows.
- [ ] Check `forget_device` survived and no longer references vouchers:
      ```sql
      select p.proacl, pg_get_functiondef(p.oid)
        from pg_proc p where p.proname = 'forget_device';
      -- expect: SECURITY DEFINER, search_path=public, only
      -- "DELETE FROM public.question_reports", EXECUTE for anon,
      -- authenticated, service_role (none for PUBLIC)
      ```
      and that the public key may call it (an unknown id is a no-op):
      `curl … /rest/v1/rpc/forget_device -d '{"p_device_id":"release-check"}'`
      → HTTP 204/200.

**Why first:** if the app ships without them, it still works — every trial
just lives on the device, so a reinstall starts a new one — and nothing
anywhere reports the problem.

### 2. RevenueCat

- [ ] Entitlement identifier stays **`no_ads`**; set its description to
      "Deblochează aplicația".
- [ ] The existing iOS and Android products are still attached to `no_ads`.
      Do **not** create new products.
- [ ] The **current** offering contains the package with that product; set its
      display name to "Deblochează aplicația".
- [ ] **CRITICAL (Android):** RevenueCat → Products → the Play one-time
      product is marked **Non-consumable**. If it is treated as consumable, the
      SDK consumes the purchase after granting it — the buyer loses it on the
      next reinstall / new phone and *Restore* finds nothing. Check it before
      the first 1.1 sale; it is a dashboard setting nothing in the repo can
      verify.
- [ ] Project settings → **Restore behavior = "Transfer to new App User ID"**
      (the default). The silent sync and *Restore* depend on it.

### 3. App Store Connect (version 1.1)

- [ ] In-app purchase: edit the **existing** product's display name and
      description (text in [`app-store-listing.md`](./app-store-listing.md#in-app-purchase-metadata)),
      replace its review screenshot (the old one shows ad removal), and submit
      it together with the 1.1 binary.
- [ ] App Review notes: paste the block from
      [`app-store-listing.md`](./app-store-listing.md#app-review-notes-paste-into-app-store-connect--app-review-information).
      It tells the reviewer the fresh install shows the intro and that
      *Cumpără acum* opens the purchase immediately, so they don't wait 5 days.
      Attach a short screen recording of intro → lock screen made with a dev
      build (simulator is fine) and the *Expiră perioada de probă (dev)* button.
- [ ] Description, promotional text and What's New from `app-store-listing.md`;
      Marketing URL → `https://chestionarebarca.bhdit.ro/`.
- [ ] Check the archived build's `Info.plist` has no `GADApplicationIdentifier`,
      no `SKAdNetworkItems` and no `NSUserTrackingUsageDescription`.
- [ ] Check the privacy manifest: Xcode Organizer → the archive →
      *Generate Privacy Report*. The app's own `PrivacyInfo.xcprivacy`
      (mirrored in `app.json` → `ios.privacyManifests`) declares Device ID,
      Purchase History and Other User Content, all *not linked*, *not
      tracking*, App Functionality; RevenueCat's SDK adds its own Purchase
      History entry. The App Privacy answers below must cover at least these.
- [ ] Check the store build has no test tools: on the TestFlight build,
      Settings shows no *Expiră perioada de probă* and no *Test notificare*
      (Xcode Cloud archives Release with no `APP_VARIANT`; see
      `src/lib/buildFlags.ts`).
- [ ] **At release** (not before — the live 1.0.x still shows ads): update
      **App Privacy** as in `app-store-listing.md` (remove Advertising Data;
      declare Device ID, Purchase History, Other User Content; Tracking: No).

### 4. Google Play Console

- [ ] Fix the payments profile payout hold (Linear **BHD-159**) and check
      developer verification (**BHD-160**) first — selling the unlock depends on
      both.
- [ ] Monetize → In-app products: edit the **existing** product's title and
      description (text in `app-store-listing.md`).
- [ ] Before declaring "no advertising ID", check the bundle no longer asks for it:
      ```sh
      bundletool dump manifest --bundle build/production.aab | grep -i AD_ID
      # expect no output
      ```
- [ ] With the 1.1 production release — not before, and only after the
      `AD_ID` check above is clean (`app.json` blocks the permission; the
      merged manifest is what counts): App content → **Ads: No**;
      **Advertising ID: not used**; **Data safety** as in `app-store-listing.md`
      (Device or other IDs: App functionality + Fraud prevention; Purchase
      history; Other user-generated content; deletion: the in-app button for
      reports, email for the rest).
- [ ] On the internal-testing build, Settings shows no test tools (the
      production profile never sets `APP_VARIANT`; `app.config.js` also refuses
      `isPreview` for an EAS `production` build, and the app checks the
      `.preview` package at run time).
- [ ] Store listing: short and full description from
      [`store-listing.json`](./store-listing.json).

### 5. Legal pages — published from the repo

The app, both stores and the website link to
<https://chestionarebarca.bhdit.ro/privacy/> and
<https://chestionarebarca.bhdit.ro/terms/>. `website/build.sh` copies them
straight from `docs/privacy-policy.html` and `docs/terms-of-service.html`, so
editing those files and deploying the website (`cd website && ./build.sh &&
npx wrangler deploy`) is the whole process — publish **before submitting** a
store build that depends on the new text. The old Google Sites pages
(`sites.google.com/view/chestionare-barca-*`) are retired; versions up to
1.1.0 (23) / iOS (4) still link to them, so leave them up with a pointer to
the new address until those builds are gone.

### 6. Website

- [ ] Fill the `TODO(owner)` in `website/index.html` (the unlock's RON price in
      the schema.org data) once the price is final, then deploy as described in
      `website/README.md`.
- [ ] If an `app-ads.txt` was ever published for this app on the developer
      website listed in the stores, remove this app's line (the repo has none).

### 7. After rollout

- [ ] Trials are being recorded:
      ```sql
      select date(started_at) as day, platform, count(*)
        from public.trials group by 1, 2 order by 1 desc limit 14;
      ```
      Installs happening but no rows means the RPCs are failing.
- [ ] RevenueCat → Overview shows purchases and restores.
- [ ] Old 1.0.x installs keep requesting ads until they update. Once few remain,
      check the AdMob balance and archive the AdMob apps (iOS and Android).

## Store policy notes

What the trial-then-unlock model relies on, and how the app meets each point.
Treat these as requirements when changing the intro, the paywall or the
listings.

### Apple

- **Guideline 3.1.1 — time-based trial for a non-subscription app.** Verdict:
  a $0 "5-day Trial" non-consumable IAP is **not required**. What is required,
  and what `TrialIntro` does: **before** the trial starts, state its length
  (5 days), what becomes inaccessible when it ends (*Toată aplicația se
  blochează: întrebările, simulările de examen, cursurile, istoricul și
  setările* — progress is kept), and the price of the one-time
  unlock (the store's `priceString`); the trial starts **only** on an explicit
  tap of *Începe perioada gratuită*. *Contingency:* if a reviewer still asks
  for the "free trial IAP" pattern, add a $0 non-consumable "Perioadă de
  încercare de 5 zile" whose purchase starts the trial (start_trial runs on
  its success); the server-side trial rules stay as they are.
- **Restore Purchases must always be reachable:** on the intro (*Am cumpărat
  deja — Restaurează achizițiile*), on the paywall (prominent card) and in
  Settings → *Acces*.
- **Never call `restorePurchases()` at launch** — on iOS it can prompt for the
  Apple ID. The only automatic call is the silent `syncPurchasesForResult()`,
  once per install (above), which never prompts.
- **The reviewer must be able to buy during the trial:** *Cumpără acum* on the
  intro and *Deblochează aplicația* in Settings open the purchase at once.
- **No hidden or dormant features (2.3.1):** the *Expiră perioada de probă* and
  *Test notificare* buttons exist in the code but are unreachable in a store
  build: `DEV_TOOLS_ENABLED` (`src/lib/buildFlags.ts`) is `__DEV__` (false in
  Release) or `extra.isPreview` — which `app.config.js` sets only for
  `APP_VARIANT=preview`, never for an EAS `production` build, and which Xcode
  Cloud never sets — plus, on Android, the `.preview` package at run time.
  `devExpireTrial()` is a plain refresh unless that flag is on.
- **Wording:** no "gratuit" on the paywall (its title is *Perioada de încercare
  s-a încheiat*). The listing says what the model is: free download, 5-day
  trial, then a one-time in-app purchase.
- **App Review notes:** paste the block from `app-store-listing.md`, and attach
  a **screen recording (or screenshots) of the expired paywall** — made with a
  dev build or simulator using *Expiră perioada de probă (dev)* — so the
  reviewer sees the locked state without waiting 5 days. Replace the IAP's
  review screenshot (the old one shows ad removal).
- **App Privacy + privacy manifest:** see the checklist (Device ID, Purchase
  History, Other User Content; not linked; no tracking).

### RevenueCat

- A **reinstall** gets a new anonymous app user id that does **not** see the
  old non-consumable until a restore or sync. Hence the silent sync (once per
  install, only on a definite *no*, before the first screen) and Restore on
  every screen.
- **Restore behavior** must stay **"Transfer to new App User ID"**.
- **CRITICAL — Android product type.** The Play one-time product must be
  marked **Non-consumable** in RevenueCat, or purchases get consumed and
  cannot be restored. If a buyer is already affected, the support path is:
  ask for the Google Play order id (GPA.…), find the transaction in RevenueCat
  → *Customers* (search by order id) and **transfer** it to the buyer's current
  app user id, or grant a **promotional entitlement** `no_ads` (lifetime) to
  that app user id. Same for any other "I paid but it's locked" report that
  Restore doesn't fix.

### Google Play

- Show the store's **`priceString`** only — never a hardcoded or reformatted
  price.
- **Data safety:** add *Device or other IDs* (App functionality + Fraud
  prevention, security and compliance) and *Purchase history*; keep *Other
  user-generated content* (question reports). Deletion: the in-app button
  deletes reports; the rest by email.
- **Ads declaration "No" and Advertising ID "not used"** only once the merged
  release manifest has no `com.google.android.gms.permission.AD_ID`
  (`app.json` → `android.blockedPermissions` removes it; verify with
  `bundletool`, checklist step 4) — and only together with the 1.1 production
  release, since 1.0.x still shows ads.

### EU / Romania (consumer law, GDPR)

- Never call the **app** "gratuită". Say *descărcare gratuită, 5 zile de
  încercare, apoi plată unică* (listings, website, store text). "Perioada
  gratuită" for the trial itself is accurate.
- Show the **VAT-inclusive** store price (the store's `priceString` is) before
  the trial starts and on the paywall.
- Do **not** claim the purchase is "nerambursabil": refunds go through Apple /
  Google under their policies and EU law; a refund simply removes the unlock.
- The **hashed device key is pseudonymous personal data**, not anonymous: the
  privacy policy gives its legal basis (legitimate interest — one trial per
  device), its retention (as long as the app is offered; kept through *Șterge
  toate datele* and reinstall) and the route to object or ask about it
  (email).
