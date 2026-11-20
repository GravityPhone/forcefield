# Forcefield demo: petition and registration

One sitting, about 15 minutes: 6 for the petition side, 8 for the registration side, the rest for questions. Each half also stands alone.

Lines in quotes are the script. Say them in your own words; the point of each one is the sentence after "Point:".

---

## What you need to know going in

**The site.** https://forcefield.ninja. It is a web app. On a phone it fills the screen; on a laptop it draws itself as a phone-sized column in the middle of the window with "Phone app demo" beside it. That is on purpose, so a laptop on a projector shows exactly what a volunteer's phone shows.

**Your accounts.** Both sign in with Google.

| Account | Shows as | Role | Use it for |
|---|---|---|---|
| Steven Sorensen | Steven S. | Canvasser | The whole demo. It is on a squad with doors assigned. |
| Steven Sorensen 2 | Barry | Campaign manager | A spare. Not needed. |

Use **Steven S.** for everything. When you need manager screens, tap the role badge in the header (it says Canvasser) and pick Campaign Manager. That switch is a demo affordance, and the sheet says so. Tap it again to go back.

**Two campaigns, two modes.** The app decides what it looks like from the campaign you are in:

- **Demo Campaign** is a petition drive. Goal 4,000 signatures, about 2,900 collected, deadline December 12.
- **Voter Registration Demo** is a registration drive. Goal 1,500, about 380 registrations.

The colored strip under the header says which mode you are in and has the button that flips to the other. Flipping moves you to the other campaign. The doors and the map are the same on both sides; the buttons, the tabs and the numbers change.

There is a third campaign called UBI. It is an empty leftover. If the progress card ever says "0 of 8,000" you are in it: open More > Campaign and tap the Demo Campaign chip.

**Everything is sample data.** The voter file is real Union County public data (about 22,700 addresses), but every knock, signature, registration, squad and staff member was generated. The 77 petition staff and the 20 registration staff are separate made-up people. Say so if asked. Nothing here is anyone's real campaign.

**What is in the data today.**

Petition side:
- A month of history ending today, 450 to 850 knocks a day.
- 13 turfs cut today, all in one neighborhood of Marysville. Six are out with crews, seven are waiting.
- Six squads out. Yours is **Big Sigs** on the **Mill Wood Blvd** turf, with Corey W., Andre M. and Cassie D. The turf is split four ways. Your share is 42 doors on Clydesdale Way, Deer Crossing Dr and Stable St. Nobody has knocked your share today; your squadmates have been working theirs.
- Three petition sites (Farmers market, Public library, Grocery store) with about 46 entries today.

Registration side:
- Six sites, three weeks of shifts: two weeks behind today, one week ahead.
- Three shifts today: Grocery store 9 to 1 (10 of 10), Community college 11 to 3 (14 of 20 and climbing), Transit stop 3 to 7.

---

## Before the meeting

Do these in order. Steps 1 and 2 need the computer with the project on it.

**1. Bring today up to the minute.** Run both, as close to the meeting as you can. The first tops up today's petition knocks to the current time without touching turf or squads. The second rebuilds the registration sample data around right now.

```
node scripts/demo-today.mjs --top-up
```

```
node scripts/demo-registration.mjs
```

**2. Put the sample plan in Google Sheets.** This is for the import step. Do it fresh today, because the rebuild rewrites the file with next week's dates and the current staff names.

- Go to sheets.google.com and start a blank sheet.
- File > Import > Upload, and choose `demo/site-plan-sample.csv` from the project folder. Pick "Replace spreadsheet".
- Share (top right) > General access > **Anyone with the link**, Viewer.
- Copy the link. Keep the sheet open in its own tab.

**3. Sign in.** Open https://forcefield.ninja on the device you will present from and sign in with Google as Steven Sorensen. Close and reopen the tab once so it has the newest version.

**4. Check where you are.** The header should say Forcefield with a DEMO chip, your name, and a Canvasser badge. The strip under it should say **Petition mode**. Open More > Campaign and confirm the chip that is lit is **Demo Campaign**.

**5. Location.** The Map tab and the turf page ask for your location. Allow it or decline it; either works. If you are not in Union County the map opens on Marysville anyway.

**6. If you are projecting from a laptop,** make the browser window tall. The app is a phone column, and a short window cuts the bottom tab bar close.

**7. Reload every tab you will use.** A tab left open from before an update can fail to open a page it has not visited yet (the link does nothing). Close it and open the site again.

**8. Have these ready to type.** Each was checked against the database and returns exactly one person when typed as written.

| For | Type | What it is |
|---|---|---|
| Petition door | `1856 Deer Crossing` | Two residents, last visit Not Home |
| Petition site signature | `Ambica Gawarla` | Registered voter in Marysville |
| Registration: already registered | `Nidhi Parashar` | Registered |
| Registration: needs an update | `Shahin Armin` | Registered |
| Registration: not registered | `Kurt Luebkeman` | In the file, marked not registered |
| Registration: not registered, spare | `Damon Sharp` | Same |
| Registration: not in the file at all | `Marcus Delacroix` | No match |
| Registration door | `1819 Deer Crossing` | One resident registered, one not |

**About "not registered".** The voter file is a list of registered voters, so on its own it has nobody to register. For this demo about one person in six in Marysville (4,024 of 22,980) is marked not registered. It is simulated: these are real names from the public file with a made-up status. Nobody who signed the petition is in that group. If anyone asks, say so. A real drive would load a list of unregistered residents, or use the app with only the "not in the file" path.

---

## Part 1: the petition side (about 6 minutes)

You are Steven S., a canvasser, in Petition mode.

### 1. Canvass, Talk tab: one house

Tap **Canvass** in the bottom bar. It opens on **Talk**. Type `1856 Deer Crossing` in the search box and tap the address.

You see the address, the two people registered there, the six outcome buttons, and under them the visit history.

> "This is the screen a volunteer has in their hand on a porch. One house, the people who live there, and six buttons. It is built to be used one-handed in daylight."

Tap **Judith Ann Wesney**, then tap **Signed**. Her name turns green. The banner says 1 of 2 signed.

> "A signature belongs to a person, so Signed needs a name. Everything else can be logged against the house if you are not sure who you are talking to."

Point: logging a knock is two taps.

Tap **Signed** again to undo it, so the door stays available. (Tap-again is the undo.)

### 2. Moving down the street

Under the buttons: **Back** and **Next**, two square buttons (**My turf** and **My doors**), and **Up next** with the next four houses.

Tap **Next**.

> "Next takes you to the next house on the street in walking order. It skips houses that are finished: everybody signed, or they said no. You can walk up or down, odds or evens."

Tap the **My doors** square. A list of your crew's streets opens. Close it.

Point: the app knows the walking order, so nobody plans a route.

### 3. Canvass, Map tab

Tap **Map** at the top.

> "Same doors on a map. Each dot is a house and the color is what happened there. Green is signed. Green with a yellow band is some of the household signed. Red is a no. Grey is nobody home. Blue has never been knocked."

Tap **My turf** on the map. The map filters to your squad's ground and flies there. Tap **My doors** to narrow it to your own 42.

Tap any dot. A card names the house; **Knock** opens it in Talk.

Point: the map is the same data as the list, live. A dot changes color the moment anyone logs it.

### 4. Canvass, Site tab

Tap **Site** at the top.

> "Not every signature comes from a door. This is for a table at a market or outside a library."

The tab is already on a site: Farmers market. Type `Ambica Gawarla` and tap her. Tap **Signed**.

> "You look the person up on the voter roll, because only a registered voter's signature counts. It is filed against the site, it counts toward the goal like any other signature, and her own house turns green so nobody knocks it to ask again."

Tap **Undo my last**.

Point: door work and site work land in one count.

### 5. Squad

Tap **Squad** in the bottom bar.

> "A squad is whoever went out together today. This is my crew of four and the turf we were given."

- The map shows the crew's doors. The rings are in each person's color, so you can see who has which stretch. A small face on a door means that person knocked it today.
- Under the map: doors knocked today, and **Our doors**, which opens a count by outcome.
- The four tiles are the crew. Tap **Cassie D.** Her sheet shows her knocks today and has Assign, View profile, Show on map and Call.

> "A squad leader can hand a stretch of doors to a person by drawing around them on the map. Or flip one switch and let people claim their own."

Close the sheet. (Only demo Assign if you have time: tap Assign, the map shows the lasso and street tools, cancel with the X.)

Point: the leader sees who is where and what is left, without a phone call.

### 6. Feed and Leaders

Tap **Feed**.

> "Everything the whole campaign has done today, as it happens. Milestones show up on their own."

Tap **Leaders**.

> "Canvassers and squads ranked for today or all time. It is there because this work is easy to quit, and a little friendly competition keeps people coming back."

### 7. Switch to manager

Tap the **Canvasser** badge in the header and choose **Campaign Manager**. The bottom bar changes to Dashboard, Canvass, Squads, Turf, Feed, Leaders.

> "Everything so far is what a volunteer sees. This is the person running the day."

### 8. Turf

Tap **Turf**.

> "Turf is how you divide the town so two crews never knock the same street. These were cut this morning. Each color is one turf."

The map shows 13 turfs as colored rings on the doors. Tap any door: a bar at the bottom names its turf.

Scroll below the map and open **Today's turf**. Tap **Pepper Ln** (one of the seven not sent out). In the sheet, pick a squad from the dropdown, for example Renata's squad.

> "Sending a turf to a crew is one dropdown. It shows up on their phones straight away."

Optional, if they ask how turf gets made: tap **+ Create new turf**, type a street name, tap it, tap **Add**. Then **Cancel** at the top right of the map.

Point: dividing and dispatching ground takes minutes, on a phone.

### 9. Analytics

Open **More > Analytics**.

- **Overview**: knocks, conversations, signatures, sign rate, and signatures per day with a 7-day average.
- **Turf** and **Squads**: the same numbers for each turf and each crew. Tap a bar once to read it, tap the popup to open that turf or squad.
- **Odds**: type a street or a house and it says how likely the next knock there is to be answered and to sign, and what time of day is best.

> "This is all computed from the knocks, nothing is entered twice. The odds page is a prediction, and it shows how well it has actually predicted the last week, so nobody has to take it on faith."

Point: a manager can answer "where should we go tomorrow" from their phone.

### 10. Close the petition half

Open **More > Campaign**. The progress card shows signatures against the 4,000 goal and days left to the deadline.

> "That is the petition tool. Now the same app as a registration drive."

---

## Part 2: the registration side (about 8 minutes)

Stay as Campaign Manager.

### 1. Flip the mode

On Canvass (or any page), the strip under the header says Petition mode. Tap **Switch to registration**.

The strip turns green and says **Registration mode**. The bottom bar becomes Sites, Canvass, Turf, Feed, Leaders, Analytics.

> "One tap. Same people could be in both, same map, same voter file. What changes is what you can log and what gets counted. There are no squads here, because a registration drive staffs shifts at places."

Point: one tool for both kinds of work, not two.

### 2. The site plan

Tap **Sites**.

- Two numbers at the top: registered today and updated today, across every site.
- A row of days. It opens on today. Dashed days have nothing planned.
- Today's three shifts: the site, the hours, who is on it, and registrations against the goal.

> "This is the site plan. Who is standing where, what hours, and how it is going against the goal for that shift."

Tap tomorrow in the row of days, then tap back to **Today**.

Tap the **Community college** shift. It opens the shift: the crew, and the count by result.

Point: the plan and the results are the same screen.

### 3. Work a site

Go back, tap **Canvass**, then the **Site** tab.

It is already on a site (the shift happening now), so everything you log is filed against that site without picking anything. The count says how many registered here today.

> "This is what the person at the table uses. Somebody walks up and you look up their name. There are three things that can happen."

**One: they are already registered.** Type `Nidhi Parashar`. She comes up with no tag. Tap her. The pill says **Registered** and the choices are **Already registered**, **Updated**, **Declined**. Tap **Already registered**.

> "She is on the roll. Nothing to do, and we note that we checked."

Type `Shahin Armin`, tap, then **Updated**.

> "Also registered, but he has moved. That is an update, and it counts toward the goal."

**Two: they are in the file but not registered.** Type `Kurt Luebkeman`. His row has an amber **Not registered** tag. Tap him. The choices are now **Registered**, **Not eligible**, **Declined**. Tap **Registered**.

> "The app already knows he is not registered, so it offers to register him. That is a new registration, the number you are here for."

Type `Kurt Luebkeman` again. The tag is gone: he reads as registered from now on.

**Three: they are not in the file at all.** Type `Marcus Delacroix`. No matches. Tap **Not on the roll**, then **Registered**.

> "Somebody new to the county, or newly eligible. Same result, and the app keeps only the count. No birth date, no licence number, no reason if someone is not eligible. The paper form or the state website is the legal record."

All four are in **Today here**. Tap **Undo my last** four times to take them back.

Point: the lookup decides the buttons, so a volunteer cannot log the wrong kind of result.

### 4. Which sites are worth a crew

Tap **Sites** in the bottom bar, then the **Sites** chip (next to Shifts).

> "Every place you work, with what it has produced. The community college leads. The library is slow. That tells you where to put people next week."

### 5. Add a site and plan a shift

- Tap **+ Add site**. Name it `Rec center lobby`. Save.
- Tap the new site, then **+ Add a shift here**.
- Tap a start time (10 AM), a length (3 hours), a goal (15). Add a crew member from the list. Save.

> "Planning a shift is a few taps. No typing times."

The shift is planned for whichever day was showing on the Shifts list.

### 6. Import your own spreadsheet

> "Most teams already have their site plan in a spreadsheet. You do not have to retype it."

- On Sites, tap **Import**.
- Paste the Google Sheet link and tap **Read**.
- The app shows how it matched the columns: Location to Site name, Hours to Start time, Target to Goal, Staff to Crew. Any of them can be changed.
- Tap **Link and import 4**.

Swipe the row of days to next week. The four shifts are there. "County fairgrounds, gate B" was not a site before; the import created it.

Now switch to the Google Sheet tab and change a Target (25 to 40). Back in the app: **Import**, then **Refresh** next to the sheet's name. The goal updates.

> "It stays linked. Change the sheet, tap refresh, the plan follows. It never deletes a shift that already has registrations on it."

If the link fails in the room: copy the rows in Sheets, paste them under "or paste rows", tap Read rows.

Point: they keep their spreadsheet and get the app on top of it.

### 7. Doors, for drives that also knock

Tap **Canvass**, **Talk** tab, search `1819 Deer Crossing`.

> "If you also go door to door, it is the same house screen with registration buttons."

Two people live here. David has a **Registered** badge. Meghan has an amber **Not registered** badge.

> "Before you knock you can see who at this address still needs registering. That is who you ask for."

The buttons are Registered, Updated, Already registered, Not eligible, Declined, Return, Not Home, Skip. The visit history here is this campaign's only; the petition's visits to the same house do not show.

### 8. The numbers

Tap **Analytics**.

- **Overview**: registrations, split into new and updated, registrations a day, and how many came from sites and from doors.
- **Sites**: registrations by site and per shift.
- **People**: registrations by person and per day out.

> "It counts registrations and nothing else. Already registered, not eligible and declined are not in these numbers."

### 9. Ask the assistant (optional)

Only if you tested it today. Open **More > Assistant**. In registration mode it starts a fresh conversation and offers registration questions.

Tap **Which sites are worth a crew?**

> "It reads the same live data and answers in plain words. It compares sites by registrations per staffed hour, because a four-person afternoon and a one-person hour are not the same effort."

It will not quote a "conversion rate" for a site, on purpose: nobody counts the people who walk past a table, so that number would be invented.

### 10. Progress and back

Open **More > Campaign**. The card shows registrations against the 1,500 goal.

Tap **Switch to petition** on the strip to finish where you started.

> "Same app, same phones, same volunteers. A petition this month, a registration drive next month."

---

## If they ask

- **Is this real data?** The addresses and names are the public voter file for one Ohio county. All activity is generated.
- **What do you store about someone who registers?** A count. If they were found on the roll, a pointer to that voter-file row. Nothing from the form.
- **Does it work without signal?** Door knocks do: they queue on the phone and send when signal returns, and today's doors are saved on the phone. Site entries and appointments need signal.
- **Is it an app store app?** It is a website that installs to the home screen. Native Android and iPhone shells exist in the project but are not published.
- **Can it take our spreadsheet?** If it has one row per site per day, yes, whatever the columns are called. A calendar-style grid would need its own handling.
- **Does the sheet have to be public?** For now it must be shared as "Anyone with the link". A private connection is not built.
- **VAN or MiniVAN?** Not connected. No export either.
- **How do people join?** They sign up with Google or a username and land in the demo campaigns automatically. A manager sets their role.
- **Can a volunteer see where teammates are?** On the petition side a squad member can switch on location sharing for their squad, while the app is open. It does not track in the background.
- **Cost?** Not something the demo answers.

## Known rough edges

So nothing surprises you on stage:

- Map dot colors include every campaign's visits. In registration mode the map still shows the petition's colors.
- In registration mode, Leaders and Feed still show a "conversations" figure next to registrations.
- A petition signature taken at a site is counted by Analytics as a conversation at that person's home door.
- The Assistant (More > Assistant) only answers if an Anthropic API key is saved in Settings, and its registration answers are new today and untested on the live site. Ask it one question before the meeting; skip the step if the answer is off.
- "Not registered" is a simulated status on real names. See the note under Before the meeting.
- The first time the Turf page or Map opens on a device it loads the whole county and can take several seconds. Open both once before the meeting so they are instant.
- If your location is far from Ohio the maps open on Marysville, which is what you want.

## Putting it back afterwards

Anything you logged and did not undo is real data in the demo. To reset:

```
node scripts/demo-today.mjs
```

rebuilds today's petition turf, squads and knocks from scratch (it deletes the turf first). And

```
node scripts/demo-registration.mjs
```

rebuilds the registration sample, including removing the site and shifts you added or imported.
