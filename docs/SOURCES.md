# Rule sources and verification status

Let Ready encodes several legal and safety rules. This file records where each rule comes from, how well it was checked, and where the sources disagree. Re-check this file whenever the rules change. The app's guidance text points people to gov.uk, but this document is the record of what the code assumes.

Status key:

- **Confirmed (gov.uk)**: the official gov.uk page was retrieved and says this.
- **Confirmed (official body)**: a regulator or legislation source said this (for example HSE, or legislation.gov.uk).
- **Consistent (secondary)**: several council or industry pages agree, but no official page was retrieved.
- **Conflicting**: sources disagree. The app avoids depending on the disputed detail.
- **Not verified**: a claim seen in one source only. The app does not rely on it.

Checks were run on 30 October 2026.

## Gas safety (CP12)

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| Gas safety check at least every 12 months, by a Gas Safe engineer | Confirmed (official body) | [HSE: gas safety FAQ for landlords](https://www.hse.gov.uk/gas/domestic/faqlandlord.htm) |
| Give existing tenants the record within 28 days of the check; new tenants before they move in | Confirmed (official body) | [HSE: gas safe record and what to keep](https://www.hse.gov.uk/gas/landlords/gassaferecord.htm) |
| Keep records for at least two years | Confirmed (official body) | HSE, as above |

The gov.uk guidance page for landlord gas safety was not retrieved. The HSE pages are the regulator's own guidance and were used instead.

App behaviour: the default validity is 12 months from the completed date. The guidance text states the 28-day and two-year rules.

## Electrical safety (EICR)

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| Inspection at intervals of no more than 5 years, or shorter if the last report says so | Confirmed (official body, via the 2020 regulations) and consistent (secondary) | [Electrical Safety Standards in the Private Rented Sector (England) Regulations 2020](https://www.legislation.gov.uk/ukdsi/2020/9780111191934); [gov.uk guidance on electrical safety standards in the private and social rented sectors](https://www.gov.uk/government/publications/electrical-safety-standards-in-the-private-and-social-rented-sectors-guidance/electrical-safety-standards-in-the-private-and-social-rented-sectors-guidance) |
| Applies to new tenancies from 1 July 2020 and existing tenancies from 1 April 2021 | Consistent (secondary) | Council guidance (Richmond, Wandsworth, Torbay and others) |
| Copy of the report to tenants; remedial work deadlines are set by the report | Consistent (secondary) | Council guidance |

App behaviour: the default validity is 5 years from the completed date. The app does not model the 2020 start dates, because it tracks each property's current report rather than tenancy start dates for this rule.

## Energy performance certificate (EPC)

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| EPCs are valid for 10 years | Consistent (secondary) | Council guidance (Wrexham, Oxford, Cambridge and others) |
| Private rentals generally need a rating of E or above, unless a valid exemption is registered | Consistent (secondary) | Council guidance; the gov.uk non-domestic minimum standard page confirms the E rule for non-domestic property |
| Proposed rise to a C minimum rating by 2030 | **Not verified.** One council page mentions it. | Croydon council page |

App behaviour: the checklist uses the E rule as written in the guidance text. The C-rating proposal is not applied, and the guidance text tells the user to check gov.uk for changes.

## HMO licence

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| Mandatory licensing for houses with five or more occupants forming two or more households | Consistent (secondary) | Council guidance (Bury, Redbridge, Wigan, Barnsley) |
| Licences are usually granted for up to five years, and can be shorter | Consistent (secondary) | Council guidance (Bury, Southampton, Barnsley) |
| Penalties of up to £30,000 for an unlicensed HMO | Not verified, one source only | Barnsley council page. Not used in the app. |

The gov.uk HMO page was not retrieved. The app does not enforce the licence term. It records the expiry date that the landlord enters from the licence.

## Tenancy deposits and prescribed information

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| The deposit must be put into a scheme within 30 days of receiving it | **Confirmed (gov.uk)** | [gov.uk: tenancy deposit protection](https://www.gov.uk/tenancy-deposit-protection), Overview section: "Your landlord or letting agent must put your deposit in the scheme within 30 days of getting it." |
| Prescribed information must be given within the same 30 days | Confirmed (official body) and consistent (secondary) | Housing Act 2004 as summarised in secondary guides; the gov.uk page links to a separate page on prescribed information, which was not retrieved |
| A court may order compensation of 1 to 3 times the deposit for late protection | Consistent (secondary) | Several legal guides. Not used in the app. |

App behaviour: each tenancy with a received deposit gets two checks, deposit protection and prescribed information. Each has a deadline of 30 days after receipt. Protecting or giving information after the deadline is shown as "Completed late". The app does not state any penalty amount.

## Renters' Rights Act 2025 and the PRS Database

| Rule the app uses | Status | Sources |
| --- | --- | --- |
| Main tenancy reforms commenced on 1 May 2026 | Consistent (secondary) | Lexology, Gowling, Goodlord and other legal summaries. Not stated by an official page that was retrieved. |
| PRS Database registration opens in stages from 15 December 2026 | **Conflicting.** A gov.uk news item and roadmap are cited, but one law firm says the government has not yet confirmed the start date. | [gov.uk: implementing the Renters' Rights Act roadmap](https://www.gov.uk/government/publications/renters-rights-act-2025-implementation-roadmap/implementing-the-renters-rights-act-2025-our-roadmap-for-reforming-the-private-rented-sector); [Osborne Clarke](https://www.osborneclarke.com/insights/renters-rights-act-phase-2-introduces-landlord-database-and-rent-dispute-reforms-england) |
| Regional deadlines (for example West Midlands 14 March 2027, all landlords 14 November 2027) | **Conflicting.** A council page gives a different regional date. | [South Holland council](https://www.sholland.gov.uk/article/29526/Renters-Rights-Act) |
| Civil penalty of up to £7,000 for letting an unregistered property | Consistent (secondary) | Council guidance. Not used in the app. |

App behaviour: the PRS Database item records the registration date. Its guidance says that registration opens in stages from December 2026 and that the user should check gov.uk for their area's deadline. The app does not compute a PRS deadline, because the regional dates are not settled in the sources.

## Summary of what the app does not rely on

- The C-rating EPC proposal, the HMO penalty amount, the Renters' Rights Act penalty, and the deposit compensation range are not used in any calculation.
- The PRS Database deadlines are left to the user, because the regional dates conflict.

## Before relying on this app for compliance

Check the current gov.uk guidance for each item. The rules in this file were last checked on the date at the top, and several sources could not be fetched directly from gov.uk.
