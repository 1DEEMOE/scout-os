# Compliance checklist for counsel

Prepared by Claude (not a lawyer) from the product's design. Each line is a question for an attorney, with what the product does today so they do not have to dig.

## Product facts (as built, mock mode only; nothing has run live)
- Messages to a business's customers are drafted by AI and need that business owner's approval before sending. No auto-send.
- Email is the live channel in design. **SMS/voice is mock-only and disabled** (no Twilio).
- Per-customer database isolation; audit log of actions; JSON export; erasure not complete.

## 1. Text/voice (TCPA, carrier rules)
- Is SMS in scope before launch? Recommended default: leave off until counsel and 10DLC registration are handled.
- If on: who obtains consent (the customer business), how it is recorded, opt-out ("STOP") handling, quiet hours, who is liable.

## 2. Email (CAN-SPAM)
- Messages are sent from the customer's own address/domain at their approval. Do they count as "commercial"? Required footer/postal address/opt-out mechanism.
- Should the product force an unsubscribe footer on bulk or follow-up sequences?

## 3. Google restricted scopes
- Gmail read/send scopes are "restricted": public apps typically need Google's OAuth verification and may need an annual third-party security assessment (CASA). Counsel/owner: is the pilot kept inside Google's testing-user limits until then?
- Privacy policy must carry the Limited Use statement (drafted).

## 4. State privacy laws and role (controller vs processor)
- California and other states: thresholds, whether we are a service provider, need for a data processing addendum offered to customers.
- Breach-notification obligations by state.

## 5. AI disclosures
- Do messages need to say they were drafted by AI? Any state rule on AI-generated customer communications? Terms say users must review (drafted).

## 6. Industry exposure
- The product has 60 industry packs, including tax, credit, health-adjacent and legal-adjacent ones. Which industries must be excluded or flagged at launch? (Tax return preparation, credit repair and debt services are regulated; the owner also runs a tax practice, which raises its own separation questions.)

## 7. Payments
- Card data never touches us (Stripe). Are we a money transmitter in any flow? Design says nothing auto-pays and there are no payouts; counsel to confirm.

## 8. Corporate
- Legal entity for the product; trademark (see `trademark-preliminary-search.md`); insurance (E&O/cyber); who signs customer contracts.
