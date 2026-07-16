# Geva Facebook Group — Critical Lines Extraction Automation

## Source

Private Facebook group:

https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY

## Objective

Every day, retrieve the previous trading day's post from Geva's private Facebook group and extract the critical support and resistance lines.

The relevant post usually begins with text similar to:

> בוקר טוב לסוחרים, יום שני

The two critical lines are:

- `קווי תמיכה:`
- `קווי התנגדות:`

The complete expanded post should also be saved for reference.

---

## Current Manual Process

1. Open the Facebook group.
2. Sort or view posts by recent activity.
3. Scroll down until the relevant previous-day post appears.
4. Identify a post containing text such as:

   ```text
   בוקר טוב לסוחרים, יום שני,
   קווי תמיכה: 7568.25?, 7529.50?, 7507.75?, 7469.00!, 7409.00! - 7398.50, 7360.25!, 7304.75, 7266.50
   קווי התנגדות: 7601.50? - 7606.00!, 7637.00! - 7648.25, 7673.50?, 7692.50!, 7728.25!
   ```

5. Press **See more** to expand the complete post.
6. Copy the complete post text.
7. Save it with a date-based identifier.
8. Repeat the process for earlier dates when needed.

Example expanded post:

```text
בוקר טוב לסוחרים, יום שני,
קווי תמיכה: 7568.25?, 7529.50?, 7507.75?, 7469.00!, 7409.00! - 7398.50, 7360.25!, 7304.75, 7266.50
קווי התנגדות: 7601.50? - 7606.00!, 7637.00! - 7648.25, 7673.50?, 7692.50!, 7728.25!
סימן קריאה - שימו לב בזהירות, כדאי להיות מול המחשב.
סימן שאלה - עשוי להיפרץ, לחכות מבחוץ ללא לימיט מראש.
*עדיין לא קראתם את הספר "סוחר אלטרנטיבי"? הספר קיים בגרסה מודפסת ודיגיטלית. להזמנות באתר בלבד!*
https://www.gevatrade.com/?p=2543
שימו לב - קווי התמיכה וההתנגדות נקבעים (על חוזה עתידי s&p500) בשעות הבוקר עבור יום המסחר הנוכחי ויש להתייחס אליהם לצורך מידע לימודי בלבד. אין בציוני המחיר שום ייעוץ או המלצה לקנות או למכור במחיר מסוים והאחריות לביצוע היא על הסוחר בלבד
```

---

## Can This Be Automated?

Yes.

However, the best initial solution is **semi-automatic**, not fully unattended.

A fully automatic scraper can technically be built, but it is less reliable because:

- The group is private and requires an authenticated Facebook session.
- Facebook page structure changes frequently.
- Posts load dynamically while scrolling.
- The **See more** button may have changing selectors.
- Facebook may restrict accounts that perform aggressive or repetitive automated browsing.
- The Facebook Groups API is no longer a practical supported method for retrieving arbitrary private-group posts.

The recommended first version should leave Facebook login and initial navigation under manual control.

---

## Recommended Solution

Build a small local browser tool, preferably one of the following:

1. Chrome extension
2. Tampermonkey userscript
3. Playwright-based local tool

The first version should work inside the already-open Facebook page.

### Manual Actions

The user:

1. Opens Facebook while already logged in.
2. Opens the Geva group.
3. Scrolls until the required post is visible.
4. Clicks one extraction button.

### Automatic Actions

The tool:

1. Scans visible Facebook posts.
2. Finds a post containing both:
   - `קווי תמיכה:`
   - `קווי התנגדות:`
3. Presses **See more** when available.
4. Reads the expanded post text.
5. Extracts the support line.
6. Extracts the resistance line.
7. Detects the post date.
8. Captures the post permalink where possible.
9. Saves the complete text.
10. Saves structured data.
11. Prevents duplicate saves.

---

## Recommended Matching Logic

A candidate post should only be accepted when it contains both required markers:

```text
קווי תמיכה:
קווי התנגדות:
```

Optional additional validation:

- Contains `בוקר טוב לסוחרים`
- Contains a Hebrew weekday
- Contains multiple decimal price levels
- Belongs to Geva or an approved group author
- Has a publication date matching the requested trading day

The extractor should not rely only on screen position.

It should search actual post text inside loaded Facebook post containers.

---

## Output Files

### Plain Text File

Recommended filename:

```text
Geva_2026-07-12.txt
```

Recommended content:

```text
DATE: 2026-07-12
DAY: יום ראשון
SOURCE: https://www.facebook.com/groups/222428877934828/
POST URL: <captured Facebook post URL>

SUPPORT:
קווי תמיכה: 7568.25?, 7529.50?, 7507.75?, 7469.00!, ...

RESISTANCE:
קווי התנגדות: 7601.50? - 7606.00!, 7637.00! - 7648.25, ...

FULL POST:
בוקר טוב לסוחרים...
```

### JSON File

Recommended filename:

```text
Geva_2026-07-12.json
```

Recommended structure:

```json
{
  "date": "2026-07-12",
  "day": "יום ראשון",
  "support": "קווי תמיכה: 7568.25?, 7529.50?, 7507.75?, ...",
  "resistance": "קווי התנגדות: 7601.50? - 7606.00!, 7637.00! - 7648.25, ...",
  "fullText": "בוקר טוב לסוחרים...",
  "postUrl": "https://www.facebook.com/groups/...",
  "groupUrl": "https://www.facebook.com/groups/222428877934828/",
  "capturedAt": "2026-07-13T12:00:00+03:00"
}
```

### Optional CSV Index

A central index can record all extracted days:

```csv
date,day,support,resistance,post_url,filename
2026-07-12,יום ראשון,"7568.25?, 7529.50?","7601.50?, 7637.00!",https://facebook.com/...,Geva_2026-07-12.txt
```

---

## Automation Levels

| Level | Description | Reliability | Recommendation |
|---|---|---:|---|
| 1 | User locates the post; tool extracts and saves it | High | Start here |
| 2 | Tool scans all currently loaded posts and finds the correct one | High–Medium | Add next |
| 3 | Tool scrolls backward until it reaches the requested date | Medium | Add after stable testing |
| 4 | Tool opens Facebook and runs automatically every day | Low–Medium | Only after extended testing |
| 5 | Fully unattended historical backfill over many days | Low | Use cautiously |

---

## Technology Options

### Chrome Extension

Best long-term browser-integrated option.

Advantages:

- Runs directly on the Facebook group page.
- Can add an **Extract Geva Lines** button.
- Can inspect visible post text.
- Can download text and JSON files.
- Can store previously processed dates locally.

Disadvantages:

- Requires extension packaging and browser permissions.
- Facebook DOM changes may require maintenance.

### Tampermonkey Userscript

Best rapid prototype.

Advantages:

- Fast to build.
- Easy to modify.
- Runs only on matching Facebook URLs.
- Can add buttons and scan page content.

Disadvantages:

- Less polished than an extension.
- Requires Tampermonkey installation.
- Still depends on Facebook's DOM.

### Playwright

Best for advanced controlled automation.

Advantages:

- Can preserve an authenticated browser profile.
- Can scroll, click, inspect text and save files.
- Better for scheduled or historical extraction.
- Easier to test than coordinate-based automation.

Disadvantages:

- More complex setup.
- Unattended Facebook automation may trigger account protections.
- Login state and Facebook checkpoints require handling.

### Power Automate Desktop

Possible, but not preferred.

Advantages:

- Visual workflow.
- Easy for basic browser actions.
- Can save files locally.

Disadvantages:

- Recorded selectors are often fragile on Facebook.
- Coordinate-based actions may break with window resizing.
- Dynamic scrolling and virtualized posts are difficult.
- Harder to maintain than a text-aware browser script.

---

## Proposed Build Order

### Stage 1 — Visible Post Extractor

Build a tool that:

- Scans visible posts.
- Finds posts containing both required markers.
- Expands **See more**.
- Extracts the complete text.
- Displays a preview.
- Saves TXT and JSON files.

No automatic scrolling yet.

### Stage 2 — Date and Duplicate Handling

Add:

- Facebook post-date detection.
- Requested-date matching.
- Filename generation.
- Duplicate prevention.
- Local extraction history.

Example local storage record:

```json
{
  "2026-07-12": {
    "postUrl": "https://facebook.com/...",
    "savedAt": "2026-07-13T12:00:00+03:00"
  }
}
```

### Stage 3 — Controlled Scrolling

Add a button such as:

```text
Find previous trading day
```

The tool should:

1. Check all loaded posts.
2. Scroll one page.
3. Wait for posts to load.
4. Check again.
5. Stop when:
   - The requested date is found.
   - A maximum number of scrolls is reached.
   - The content is older than the requested date.
   - Facebook stops loading new content.

### Stage 4 — Historical Backfill

Allow a date range:

```text
From: 2026-07-01
To:   2026-07-12
```

For every matching day:

- Locate the post.
- Expand it.
- Extract it.
- Save it.
- Add it to the index.
- Skip duplicates.

### Stage 5 — Scheduled Daily Run

Only after the earlier stages are stable.

Possible daily process:

1. Open an authenticated browser profile.
2. Navigate to the group.
3. Search for the previous trading day.
4. Extract and save.
5. Produce a success or failure log.

This stage should include strict limits:

- One run per day.
- Slow human-like scrolling.
- Maximum scroll count.
- No repeated login attempts.
- Stop immediately on checkpoint, CAPTCHA or account warning.
- Never bypass Facebook security controls.

---

## Recommended Daily Workflow

The practical initial workflow should take only a few seconds:

1. Open the group.
2. Scroll until the relevant day's post is approximately visible.
3. Click **Extract Geva Lines**.
4. Review the preview.
5. Click **Save**.

Expected result:

```text
Geva_YYYY-MM-DD.txt
Geva_YYYY-MM-DD.json
```

This provides approximately 90% automation while keeping account risk and maintenance low.

---

## Error Handling

The tool should show clear messages.

### Post Not Found

```text
No visible post contains both "קווי תמיכה:" and "קווי התנגדות:".
Scroll further and try again.
```

### Post Not Expanded

```text
The matching post may still be collapsed.
Press "See more" manually and retry.
```

### Date Not Detected

```text
The post was extracted, but its publication date could not be determined.
Select or enter the date before saving.
```

### Duplicate

```text
A file for 2026-07-12 already exists.
Choose Replace, Save Copy or Cancel.
```

### Multiple Matching Posts

Display all candidates with:

- Date
- First line
- Support-line preview
- Author
- Post URL

The user selects the correct one.

---

## Data Integrity Rules

The extractor should preserve the post exactly.

It must not:

- Change decimal values.
- Remove `!` or `?`.
- Replace hyphens.
- Reorder support or resistance levels.
- Translate the Hebrew text.
- Normalize punctuation without permission.
- Guess missing values.

The extracted support and resistance lines should be copied verbatim from the post.

The full original post should always be saved alongside parsed data.

---

## Security and Privacy

Because this is a private Facebook group:

- Keep the automation local.
- Do not upload Facebook cookies.
- Do not send the extracted post to third-party scraping services.
- Do not store passwords in scripts.
- Reuse the user's normal authenticated browser session.
- Avoid sharing the private group content without authorization.
- Stop automation if Facebook displays a security checkpoint.

---

## Final Recommendation

Start with a **Tampermonkey userscript or Chrome extension** that works on an already-open Facebook page.

The first version should:

- Find the visible matching post.
- Expand **See more**.
- Extract the two critical lines.
- Save the full post.
- Save TXT and JSON.
- Add the post date to the filename.
- Prevent duplicates.

After this works reliably, add automatic date detection and controlled scrolling.

Do not start with a fully unattended daily scraper.

The safest and most maintainable target is:

> Manual Facebook opening and positioning, followed by one-click extraction and saving.

---

## Relevant References

- Facebook Group:
  https://www.facebook.com/groups/222428877934828/?sorting_setting=RECENT_ACTIVITY

- Geva Trade:
  https://www.gevatrade.com/?p=2543

- Meta Graph API v19 announcement:
  https://developers.facebook.com/blog/post/2024/01/23/introducing-facebook-graph-and-marketing-api-v19/

- Facebook Terms:
  https://www.facebook.com/legal/terms/update/draft2

- Microsoft Power Automate browser automation:
  https://learn.microsoft.com/en-us/power-automate/desktop-flows/automation-web

- Playwright authentication:
  https://playwright.dev/docs/auth
