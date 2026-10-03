# Apple App Store Listing

Copy for App Store Connect, plus the privacy answers for both stores. The
Google Play listing text lives in [`store-listing.json`](./store-listing.json).
How access works, and the release checklist that uses this file, is in
[`MONETIZATION.md`](./MONETIZATION.md).

## App Name (max 30)
Chestionare Barca

## Subtitle (max 30)
Pregătire examen CAA C și D

## Promotional Text (max 170)
Lista oficială ANR, simulări și cursuri: 5 zile gratuit. O singură plată deblochează aplicația plus peste 300 de întrebări extra. Fără abonament, fără reclame.

## Description (max 4000)
Chestionare Barca este aplicația completă pentru pregătirea examenului de conducător de ambarcațiuni de agrement (CAA), Clasa C și Clasa D.

CE PRIMEȘTI

Toate întrebările din lista oficială ANR pentru examenul CAA Clasa C și D, plus peste 300 de întrebări suplimentare pentru exersare (incluse la deblocare), organizate pe șase categorii: COLREG, navigație, marinărie, manevre, prim ajutor și răspunsuri rapide. Întrebările sunt actualizate periodic — primești noile întrebări fără să descarci o nouă versiune.

MOD EXAMEN

Simulează examenul real: 26 de întrebări extrase din baza oficială, cronometru pornit, fără posibilitatea de a sări înainte. Vezi rezultatul la final, cu detalii pe fiecare răspuns greșit.

MOD PRACTICĂ

Exersează la ritmul tău, pe categorii. Vezi imediat răspunsul corect și explicația. Întrebările pe care le greșești apar mai des, până le stăpânești.

ÎNVAȚĂ TEORIA

Module de teorie cu un quiz la final și cursuri actualizate periodic, ca să înțelegi materia din spatele întrebărilor.

MOTIVAȚIE

• Streak zilnic — păstrează o serie de zile consecutive de studiu
• Realizări (badge-uri) — deblochezi trofee pe măsură ce progresezi
• Istoric complet — toate chestionarele rezolvate, cu scor și timp
• Reminder zilnic — notificare locală la ora pe care o alegi tu

DESIGN ȘI CONFORT

• Temă întunecată și luminoasă
• Suport iPad
• Mod offline disponibil — exersează și fără conexiune la internet
• Interfață curată, fără reclame și fără elemente care distrag

DESCĂRCARE GRATUITĂ, 5 ZILE DE ÎNCERCARE, APOI O SINGURĂ PLATĂ

Descarci aplicația gratuit și timp de 5 zile ai acces la lista oficială de întrebări, la simulările de examen și la cursuri. Perioada de încercare pornește doar când apeși „Începe perioada gratuită”. Cu o singură plată în aplicație, la prețul afișat în aplicație, o deblochezi pentru totdeauna și primești și întrebările suplimentare — fără abonament și fără reclame.

Ai cumpărat deja eliminarea reclamelor? Ai în continuare acces complet. Dacă aplicația nu te recunoaște automat, apasă „Restaurează achizițiile”.

FĂRĂ CONT

Nu îți cerem nume, email sau telefon. Progresul și setările rămân pe dispozitiv și le poți șterge oricând din aplicație.

Mult succes la examen!

## Keywords (max 100, comma-separated)
caa,barca,permis nautic,ambarcatiune,examen,chestionare,nautic,iaht,navigatie,marina

## Primary Category
Education

## Secondary Category
Reference

## Age Rating
4+

## Support URL
https://sites.google.com/view/chestionare-barca-privacy-pol/home

## Marketing URL
https://chestionarebarca.bhdit.ro/

## Privacy Policy URL
https://sites.google.com/view/chestionare-barca-privacy-pol/home

## What's New (release notes, max 4000)
Am renunțat complet la reclame. Descărcarea rămâne gratuită: 5 zile cu lista oficială de întrebări, simulări și cursuri, din momentul în care pornești perioada gratuită. O singură plată deblochează aplicația pentru totdeauna, plus peste 300 de întrebări extra — fără abonament.

Ai cumpărat eliminarea reclamelor? Ai în continuare acces complet: aplicația te recunoaște automat, iar dacă nu, apasă „Restaurează achizițiile”.

## Copyright
© 2026 Tudor Popescu

## In-App Purchase metadata

Edit the **existing** product — the one buyers of "Elimină reclamele" already
own. Do not create a new product: past buyers are unlocked because RevenueCat
maps *that* product to the entitlement `no_ads`.

| Field | Română | English |
|---|---|---|
| Display name (max 30) | Deblochează aplicația | Unlock the app |
| Description (max 45) | Acces permanent + întrebări extra | Lifetime access + extra questions |

Play Console in-app product (title max 55, description max 200):

- **Title:** Deblochează aplicația
- **Description:** Deblochează aplicația pentru totdeauna: lista oficială ANR, simulări, cursuri și peste 300 de întrebări suplimentare. O singură plată, fără abonament.

The App Store review screenshot for the product must be replaced: the old one
shows the "Elimină reclamele" row in Settings. Use the trial intro or the
lock screen instead.

## App Review notes (paste into App Store Connect → App Review Information)

```
This version removes all advertising. The app now offers a 5-day free trial
with the official exam question list, exam simulations and courses; after it
ends, a one-time non-consumable in-app purchase ("Deblochează aplicația" /
Unlock the app) is required to keep using the app. The purchase also unlocks
303 extra practice questions that are not part of the trial. It is not a
subscription. No account or login is required.

How to review:
1. On first launch the app shows a one-time screen, BEFORE the trial starts,
   stating the trial length (5 days), what becomes unavailable when it ends
   (the whole app: all questions, exam simulations, courses, history and
   settings; progress is kept and returns after unlocking) and the price
   of the one-time unlock. The trial starts only when the user taps
   "Începe perioada gratuită" (Start the free trial).
2. You do not need to wait 5 days to test the purchase: "Cumpără" (Buy) on
   that same first screen opens the purchase. During the trial, from the
   second app start on, an offer screen opens at launch; it closes with the
   X or "Mai târziu" (Later). The purchase is also reachable from the trial
   banner on the home screen and in Setări (Settings) > Acces.
   "Restaurează achizițiile" (Restore purchases) is on the first screen, on
   the lock screen and in Settings.
3. When the trial has ended, a full-screen lock screen ("Perioada de încercare
   s-a încheiat") explains that the trial is over and offers the purchase
   and Restore purchases, plus "Șterge toate datele" (Delete all data), since
   Settings can no longer be reached. Streak reminders are cancelled while
   the app is locked. A screen recording of this screen is attached.

People who bought the former "remove ads" purchase (the same product) are
unlocked automatically and never see the lock screen.
```

## Apple App Privacy (App Store Connect → App Privacy)

What changed from the previous version: **Advertising Data is gone** (AdMob
was removed) and tracking is **No**. A device identifier and purchase history
are now declared.

- **Do you or your third-party partners collect data from this app?** Yes
- **Tracking:** No. The app does not use the advertising identifier (IDFA),
  does not show the App Tracking Transparency prompt, and shares nothing with
  data brokers or ad networks.

Data types to declare (for each: *not linked to the user's identity*,
*not used for tracking*):

| Category → Type | Purpose | What it is |
|---|---|---|
| Identifiers → **Device ID** | App Functionality | The free-trial record: a SHA-256 hash of a device identifier (iOS: a random ID the app keeps in the Keychain) plus the trial start date, on Supabase. Also the random ID attached to a question report. App Functionality covers preventing a trial from being restarted. |
| Purchases → **Purchase History** | App Functionality, Analytics | RevenueCat validates receipts and unlocks the entitlement; its dashboard gives sales charts. RevenueCat's guidance: with anonymous app user IDs, answer *not linked*. |
| User Content → **Other User Content** | App Functionality | The optional message a user types when reporting a wrong question. |

Not collected: contact info, location, health, financial info (card details
stay with Apple), contacts, browsing/search history, usage data, diagnostics,
**advertising data**, sensitive info.

## Google Play Data safety (Play Console → App content → Data safety)

- **Does your app collect or share any of the required user data types?** Yes
- **Is all of the user data collected by your app encrypted in transit?** Yes
- **Do you provide a way for users to request that their data is deleted?**
  Yes. In the app, *Șterge toate datele* (in Setări, and on the lock screen
  once the trial has ended) deletes the device's question
  reports from the server and the local data; anything else by email (address
  in the privacy policy). The app has no accounts. The trial record (a hash +
  start date) is kept on purpose — see the privacy policy.
- **Shared with third parties:** No for every type. Supabase and RevenueCat
  process data on our behalf as service providers, which Play does not count
  as sharing.

| Data type | Collected | Optional? | Processed ephemerally? | Purposes |
|---|---|---|---|---|
| Device or other IDs | Yes | Required | No | App functionality; Fraud prevention, security, and compliance (one trial per device). Android: a hash of the app-scoped Android ID — **not** the advertising ID. |
| Financial info → Purchase history | Yes | Required | No | App functionality; Analytics (RevenueCat) |
| App activity → Other user-generated content | Yes | Optional | No | App functionality (question reports) |

Not collected: location, personal info, messages, photos, audio, files,
calendar, contacts, web browsing, app interactions/analytics, crash logs,
**advertising ID**.

Other Play Console declarations:

- **App content → Ads:** "No, my app does not contain ads."
- **App content → Advertising ID:** the app does **not** use the advertising
  ID. Before answering, check the release bundle has no
  `com.google.android.gms.permission.AD_ID` permission (it came in with the
  AdMob SDK; see the checklist in `MONETIZATION.md`).
- **Pricing:** the app stays *Free* to download; it now "contains in-app
  purchases" only.
