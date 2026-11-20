# Voter registration demo

A walkthrough for showing registration mode. About five minutes.

Everything in the "Voter Registration Demo" campaign is sample data: the sites are generic places, the numbers are generated, and the crew is its own set of made-up staff (the Registration Crew team), separate from the petition's.

## Before the meeting

1. Rebuild the sample data so "today" has shifts and the past two weeks have numbers:

   ```
   node scripts/demo-registration.mjs
   ```

   Run it the morning of the demo. It refreshes the sample data inside the campaign and leaves the campaign itself alone, so nobody is moved out of it.

2. Put the sample plan in Google Sheets: new sheet, File > Import > Upload, choose `demo/site-plan-sample.csv` (the rebuild rewrites it with next week's dates). Then Share > General access > **Anyone with the link**, Viewer. Keep the sheet open in a tab and copy its link.

3. Log in as a campaign manager.

## The walkthrough

### 1. Start in the petition campaign

Open **Canvass**. The strip under the header says **Petition mode**. Talk shows Signed, Not Interested, Return and the rest. This is the app as a petition tool.

### 2. Switch to registration

Tap **Switch to registration** on that strip.

The strip turns green and says **Registration mode**, and the buttons on Talk change in front of them. It is the same list of doors; only the interface changed. The button moved you to the Voter Registration Demo campaign, because the mode belongs to the campaign. **Switch to petition** goes back.

### 3. The site plan

**More > Sites.**

- The two numbers at the top are today across every site.
- The row of days under the chips opens on today. Tap another day to see what is planned for it.
- Below are that day's shifts: site, hours, crew, and registrations against the goal.

### 4. Work a site

Open **Canvass** and tap the **Site** tab. It only exists in registration mode. There are no doors, notes or next house here.

- The picker at the top lists today's shifts, then every other site.
- Type a name in **Look up a name**. Tap someone on the roll: the choices are Already registered, Updated and Declined.
- Type a name that is not there and tap **Not on the roll**: the choices are Registered, Not eligible and Declined.
- Each one lands in **Today here**. **Undo my last** takes back your most recent.

### 5. Which sites are worth a crew

On Sites, tap the **Sites** chip. One row per place, with its all-time registrations and conversations. The community college leads; the library trails.

### 6. Add a site and schedule it

- **+ Add site**, give it a name, Save.
- Tap the new site, then **+ Add a shift here**. Tap a start time, how many hours, and a goal, add crew, and Save. The shift is planned for whichever day is showing on the Shifts list.

### 7. Link your Google Sheet

- On Sites, tap **Import**. Paste the sheet's link and tap **Read**.
- Point out the column matching: the sheet says Location, Hours, Target and Staff, and the app matched them to Site name, Start time, Goal and Crew. Any guess can be changed.
- Tap **Link and import 4**. "County fairgrounds, gate B" was not a site before; the import created it.
- The sample sheet's shifts are for next week. Swipe the row of days to next week to see them.
- Now change something in the Google Sheet: raise a Target, or add a row. Back in the app, tap **Import**, then **Refresh** next to the sheet's name. The plan updates to match.

A refresh only touches shifts that came from that sheet, never past shifts, and never deletes a shift that already has registrations on it.

If the link fails in the room, paste the rows instead: copy them in Sheets, paste under "or paste rows", and tap Read rows.

### 8. Doors, for campaigns that knock

Open **Canvass**, search a street and open a house. The buttons are now Registered, Updated, Already registered, Not eligible, Declined, Return, Not Home and Skip.

### 9. The numbers

Open **Analytics**. In registration mode it counts registrations, not signatures.

- **Overview**: registrations, split into new and updated, and registrations per day.
- **Sites**: registrations and registrations per shift for each place.
- **People**: registrations by person and per day out.

It counts registrations only. People who were already registered, not eligible or declined are not counted here.

### 10. Progress, and back to petition

**More > Campaign.** The progress card counts registrations against the goal. Tap **Switch to petition** at the top to return to the petition app.

## If they ask

- **What do you store about a registrant?** Nothing. No birth date, licence number or SSN digits, and Not eligible never records a reason. The form or the state portal is the legal record.
- **Can it take our own sheet?** If it has one row per site per day, yes, whatever the columns are called. A calendar grid would need its own handling.
- **Does the sheet have to be public?** For now it has to be shared as "Anyone with the link", so anyone holding the link could read it. A private connection (share the sheet with one app account) is the next step and is not built.
- **MiniVAN or VAN?** Not connected. An export in VAN's bulk-upload format is the first step and is not built yet.
- **Crew names in an import** have to match people who already have accounts. Names with no match are listed, not created.

## Not built yet

- A second registration at the same door has no count.
- Map pin colors still reflect every campaign's visits. Talk's visit list is per campaign.
- Site taps need signal; they are not queued offline.
- No export of the registration numbers. Analytics shows them by day, by site and by person.

## Removing the sample data

```
node scripts/demo-registration.mjs --wipe
```
