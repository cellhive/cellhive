# Dashboards

This guide is for people who build, read and share dashboards in Cellhive:

- **Building**: widget types, metrics, grouping and date buckets, layout and theme.
- **Reading**: whose numbers a widget shows, what "No permission" means, how fresh the numbers are.
- **Filtering**: global filters, filter controls (slicers), cross-filtering, clicking through to the records.
- **Sharing**: share links to a dashboard, embedding, and downloading data through a share link.

Embedding a dashboard (or a view or form) in another website has its own guide: [embedding.md](embedding.md). Reading dashboards and widget data from a script with an API token is in [api.md](api.md) §11. The normative formats are in `docs/CONTRACTS.md` §16, §16A, §26.3 and §28. The architecture is in ADR-38. If this guide and those documents disagree, the contracts win. Please report the mismatch.

## Contents

1. [Who can see and change a dashboard](#1-who-can-see-and-change-a-dashboard)
2. [Building a dashboard](#2-building-a-dashboard)
3. [Widget types](#3-widget-types)
4. [Metrics, groups and date buckets](#4-metrics-groups-and-date-buckets)
5. [Whose numbers: permissions and "No permission"](#5-whose-numbers-permissions-and-no-permission)
6. [Filters, slicers and cross-filtering](#6-filters-slicers-and-cross-filtering)
7. [Records behind a number, TV mode and downloads](#7-records-behind-a-number-tv-mode-and-downloads)
8. [How fresh the numbers are: cache and realtime](#8-how-fresh-the-numbers-are-cache-and-realtime)
9. [Sharing a dashboard with a link](#9-sharing-a-dashboard-with-a-link)
10. [Downloading data through a share link](#10-downloading-data-through-a-share-link)
11. [Troubleshooting](#11-troubleshooting)
12. [Reference: limits](#12-reference-limits)

---

## 1. Who can see and change a dashboard

A base holds up to **50** dashboards (not counting the trash). They are listed under **Dashboards** in the base sidebar, below the tables. The address of a dashboard is `/b/<baseId>/d/<dashboardId>`.

| Who | Sees the dashboard | Changes it |
| --- | --- | --- |
| Base owner, base admin (organization owners and admins included) | Every dashboard of the base | Yes: create, edit, rename, duplicate, delete, restore |
| System roles **Editor** and **Reader** | Every dashboard of the base, new ones included | No |
| A custom role | Only the dashboards set to **View** in the role (base settings → Roles → the role → **Dashboards**) | No |

- **New dashboards are hidden from custom roles.** A dashboard someone just created starts at **No access** for every custom role; a base admin gives access in the role editor ("View" per dashboard, or "View all"). This is the same deny-by-default rule as for tables.
- A dashboard you cannot see does not exist for you: its address shows "not found", it is missing from the sidebar, and the API answers `404`. If you can see it but not change it, a change answers `403`.
- **Seeing a dashboard does not mean seeing its data.** Each widget still applies your table, field and record permissions (§5).
- **Trash**: a deleted dashboard and its widgets stay in the base trash (tab **Dashboards**) for **30 days**, then they are deleted for good. Only base admins see that tab and restore. Deleting a dashboard never changes the data of its tables. A dashboard whose base is in the trash cannot be opened.

---

## 2. Building a dashboard

### 2.1 Creating

Base owners and admins have a **+** next to **Dashboards** in the base sidebar (**New dashboard**). The new dashboard is called "Untitled dashboard" and opens right away. The **…** menu of each dashboard in the sidebar renames, duplicates (the copy opens; its name gets " (copy)", then " 2", " 3"… while taken) and deletes it. Names are 1–100 characters and unique in the base, ignoring case; a dashboard in the trash frees its name.

### 2.2 Edit mode

Open the dashboard and choose **Edit** (only base owners and admins see it; the address gets `?edit=1`). The edit toolbar has:

- **Add widget**: pick a table and one of the eight widget types (§3). The widget starts with a working setup based on the table's fields and appears at the bottom, with its settings open.
- **Global filters** (§6.1) and **Theme**: light, dark or "Same as each viewer's app"; series colors (app colors, color-blind safe, classic, cool); spacing (comfortable or compact).
- **Undo** / **Redo** (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y): up to 50 steps in this editing session. Undo of a deleted widget re-creates it with a new id.
- The save state ("Saving…", "All changes saved") and **Done**.

Changes are saved as you make them: a widget's settings about 0.8 s after a valid change, the layout 1 s after the last move. The widget shows its new numbers once its settings are saved. A setting the server rejects is marked on its field in the settings panel ("Not saved: fix the settings marked below").

**Layout.** The grid has 12 columns. Drag a widget by its handle or resize it from its lower right corner (screens at least 1,024 px wide). From the keyboard, the widget's **…** menu has **Move with the keyboard** and **Resize with the keyboard**: arrow keys move or resize by one cell, Enter keeps, Escape cancels. Widgets are 1–12 columns wide and 2–24 rows high, and move up to fill gaps (vertical compaction). On screens narrower than 1,024 px the dashboard shows one column, in reading order (row, then column).

**Two people editing.** Every change carries the dashboard's version. If someone else changed the dashboard in the meantime, your change is refused, the dashboard reloads with their changes and a message says so ("Someone else changed this dashboard"): make your change again if you still need it.

### 2.3 Widget settings

Every widget that reads data has a **title**, a **table**, an optional **description** and an optional **filter** ("Only records that match are counted"). Then, depending on the type:

- **Group by** (dimension), **Group dates by** (day, week, month, quarter, year) for date fields, **Range width** for number fields.
- **Split into series by** (a second dimension, bar and line charts): with series, the chart shows one metric.
- **Metrics** (calculation, field, name, color; for combo charts also bars/line and left/right axis).
- **Sort and limit**: largest first (default), smallest first, group A to Z, group Z to A; how many groups to show (1–100, default 20); **Group the rest into "Other"**.
- **Display**: bar direction, side by side / stacked / stacked to 100 %, area and smooth line, donut, legend, values on the chart, number format (as the field, number, currency, percent; decimals; short numbers like 1.2K), text when there is no data.

A widget's **filter is visible only to base admins**. Other viewers never see it (the API returns `null`), but it always applies to their numbers too.

---

## 3. Widget types

| Type | Shows | Metrics | Groups |
| --- | --- | --- | --- |
| **KPI** (`kpi`) | One number, optionally compared with the previous period, with a target (progress) and color thresholds | exactly 1 | none |
| **Bar chart** (`bar`) | Groups as vertical or horizontal bars; grouped, stacked or stacked to 100 % | 1–5 (1 with series) | 1 dimension, optional series |
| **Line chart** (`line`) | A trend, as a line or an area | 1–5 (1 with series) | 1 dimension, optional series |
| **Pie chart** (`pie`) | Each group's share of the whole (pie or donut); "Other" on by default | exactly 1 | 1 dimension |
| **Combo chart** (`combo`) | Bars and lines on a left and a right axis | 2–5 | 1 dimension |
| **Table** (`table`) | **Records**: the first N records with up to 20 chosen fields and an optional sort. **A summary by group** (pivot): one dimension and its metrics | pivot: 1–5 | pivot: 1 dimension |
| **Text** (`text`) | Notes and headings in Markdown (bold, italic, headings, lists, `http`/`https`/`mailto` links; no HTML), up to 10,000 characters | – | – |
| **Filter** (`filter_control`) | A control viewers pick a value in (§6.2) | – | – |

A table widget shows 10 rows by default, at most 500. A dashboard holds at most **30** widgets.

Charts are accessible: each chart has a text summary of its groups, **View as table** turns it into a table of the same numbers, series have patterns as well as colors, and the keyboard moves between groups (§6.3).

---

## 4. Metrics, groups and date buckets

### 4.1 Calculations

| Calculation | Field |
| --- | --- |
| **Count records** (`count`) | none |
| **Count distinct values** (`count_distinct`) | any field that can be grouped (§4.2); exact, never estimated |
| **Sum**, **Average**, **Minimum**, **Maximum** (`sum`, `avg`, `min`, `max`) | a number field, or a formula/lookup with a number result |

The settings panel offers only the fields that fit the chosen calculation. Records in the trash are never counted.

### 4.2 Fields you can group by

| Field type | Groups |
| --- | --- |
| Text, auto number | one group per value |
| Number | one group per value, or ranges of **Range width** (a value `v` falls into the range starting at `floor(v / width) × width`) |
| Single select | one group per option, in the order of the options |
| Multiple select, user (several people), link | **one group per item**: a record with two options counts in both groups |
| User, created by, updated by | one group per person |
| Checkbox | Checked / Unchecked |
| Date, date and time, created time, updated time | **Group dates by** is required: day, week (ISO weeks, starting on Monday), month, quarter or year |
| Formula or lookup | as the type of its result, when it is a single value of one of the types above |

Attachments, buttons, parent fields and formula/lookup results that are lists cannot be grouped.

- **Empty values** form their own group, shown as "(Empty)". When sorting by group it always comes last.
- **"Other"**: with **Group the rest into "Other"**, the groups beyond the limit are folded into one "Other" group whose numbers are computed again over those records (so averages and distinct counts stay correct, not a sum of averages). The pie percentages use the total over every matching record.
- A widget that would produce more than **1,000** groups (or dimension × series pairs) does not draw; choose a coarser date bucket, a range width or a filter.

### 4.3 Time zones and periods

Date buckets ("March", "Week of 2 March") and the KPI comparison follow **your time zone** in the app (the organization's time zone when there is none). A date-and-time field with a time zone of its own uses that zone. Date-only fields use the calendar date as is.

**KPI comparison** ("Compare with: The previous period"): pick a date field of the table and a period (day, week, month, quarter, year). The current period is the calendar period that contains **now** (this month, this ISO week…), the previous one is the period just before it. The KPI shows the current value, the previous value and the change in percent; the change is empty when the previous period is zero or empty.

---

## 5. Whose numbers: permissions and "No permission"

**Every viewer sees their own numbers.** A widget is computed for the person looking at it, with their current permissions: their record rules (the rows they may read), their field rules (the columns they may read) and the trash. Two people opening the same dashboard can see different numbers. A salesperson who reads only their own orders sees the count of their own orders; the base admin sees all of them.

**"You don't have permission to see this widget's data"** appears instead of a number when the widget uses anything you cannot read:

- the widget's table;
- **any** field the widget uses: the dimension, the series, a metric's field, the KPI comparison's date field, the columns or sort of a records table, and **a field in the widget's saved filter**;
- for a dimension or series that is a link: the linked table or its primary field.

In that case no number at all is shown: no total, no "Other", no comparison. The message does not say which field is the reason. A saved filter on a field you cannot read is never skipped, because skipping it would show you a larger number than the widget is meant to show.

Other states of a widget:

| State | Meaning |
| --- | --- |
| "No data" | No record you can read matches. With live filters: "No records match the dashboard filters." |
| "This widget needs to be fixed" | The table or a field the widget uses was deleted (or a field changed type). The widget keeps its settings: restoring the table or field from the trash fixes it, or a base admin edits the widget. |
| "This widget took too long to load" | The query ran longer than 10 s. Choose **Try again** a moment later, or make the widget lighter (filter, coarser buckets, fewer groups). |

Link fields show the titles of linked records only when you can read them; a group of a record you cannot read is labeled "(No access)".

---

## 6. Filters, slicers and cross-filtering

Viewers can narrow the numbers with three kinds of **live filters**. They change only what the viewer sees, never the dashboard. The server only accepts filters the dashboard declares: nobody can send an arbitrary filter on another field through the dashboard.

The filters you pick are kept in the address (`?f=…`), so copying the address shares the filtered dashboard. **Clear filters** in the filter bar removes them all.

### 6.1 Global filters

A base admin adds them in edit mode (**Global filters**): a name, a kind (date range, options, people, text search, number range) and, for each table the dashboard reads, the field it filters (one field per table, up to 20 tables; at most 10 global filters). They appear in the filter bar at the top of the dashboard. A widget on a table without a field for that filter is not filtered by it (its card says "… does not apply: it filters another table").

### 6.2 Filter widgets (slicers)

A **Filter** widget (`filter_control`) filters one field of one table:

| Kind | Field | The viewer picks |
| --- | --- | --- |
| Date range | a date field | Any time, a relative range, or a custom range (both ends included) |
| Options | a select field | one or more options |
| People | a user field | one or more people |
| Text search | a text field | text the field contains (several values: any of them) |
| Number range | a number field | a minimum, a maximum or both |

- **Widgets it filters**: a filter widget applies only to the widgets chosen in its settings, and only on the same table.
- **Default value**: shown and applied when the dashboard opens without filters in its address. Relative ranges: today, yesterday, last 7 days, last 30 days (both ending today, today included), this week, last week, this month, last month, this quarter, this year, last year. They are computed in your time zone when the numbers are read, so "this month" moves on by itself.
- **Values offered**: an options, people or text filter lists the values found in **the records you can read** (at most 200 at a time; search to find others).
- **Cascading** (**Depends on filter**): a filter can depend on another filter of the same table. Pick a province, and the district filter offers only districts of that province in the records you can read. Changing the parent clears the children.

### 6.3 Cross-filtering

Click a bar, a slice or a point to filter **every other widget on the same table** by that group; click it again to remove the filter. The filter appears as a chip ("Filtered by: Urgent") in the filter bar. From the keyboard: focus the chart, move between groups with the arrow keys, press Enter to filter; Shift+F10 opens a menu with **Filter by** and **View records** (§7.1). Widgets on other tables are not filtered. The groups of pivot tables cannot be clicked yet.

### 6.4 Filters that do not apply

A widget's card says in words when a live filter does not apply to it:

| Note | Why |
| --- | --- |
| "… does not apply: it filters another table." | The filter (or the clicked widget) is on another table. |
| "… is not applied: you can't see the field it filters." | You cannot read the filter's field. The filter is **ignored**, and your numbers are those without it. |
| "… is not applied: its field was deleted or changed." | The filter's field was deleted or no longer fits it. |

The second rule protects hidden fields: if a filter on a field you cannot read changed your numbers, you could learn its values by trying ranges. A filter widget on such a field shows "You don't have permission to use this filter".

---

## 7. Records behind a number, TV mode and downloads

### 7.1 View records (click-through)

**View records** in a widget's **…** menu (the whole widget) or in a chart's menu (one group or series) opens the records behind the number, 50 at a time (**Show more**). It applies the same permissions and filters as the widget: only records and fields you can read. Opening a record shows its detail panel. Click-through is not available through a share link, in TV mode, or for records tables (they already show records).

### 7.2 TV mode

**TV mode** (address `?tv=1`) shows the dashboard on the whole screen, without the app around it, and offers **Full screen** and **Rotate dashboards** (off, every 30 seconds, every minute, every 5 minutes; `&rotate=` in the address) through the dashboards of the base you can see. The numbers stay live (§8). Escape leaves TV mode.

### 7.3 Downloads

The **…** menu of a widget has **Download as PNG** (charts, drawn by your browser) and **Download as CSV** (the widget's table of numbers as you see it, with your live filters). Both need the **download** right of the base in your role; without it they are not offered and the API answers `403`. The CSV is the aggregate table (groups and metrics), **never the raw records**: UTF-8 with BOM, protected against formula injection like every Cellhive export, headers in your language ("Count", "Sum of Amount"…), empty groups as "(Empty)" and "Other" last. Text, filter and records-table widgets have no CSV. One export runs at a time per person (tokens included).

---

## 8. How fresh the numbers are: cache and realtime

- **Realtime.** While a dashboard is open in the app, a change to a record of a table it reads makes the affected widgets read their numbers again. Changes are gathered for 5 seconds per dashboard, so a change shows up within a few seconds. The realtime message only says *which tables* changed, never a value: each viewer reads the new numbers with their own permissions. A change to the dashboard itself (a widget, the layout) also reloads it.
- **Cache.** Results are kept for 5 minutes so that many people opening the same dashboard do not run the same queries. A cached result is **never stale**: every record change moves the table's version, which is part of the cache key, so the next read after a change computes fresh numbers. Results are shared only between viewers who can read exactly the same records and fields (two people with "only my own records" never share one); records tables are never cached. If the cache is unavailable, numbers are computed directly.
- **Share links** have no realtime: the page reads the numbers again every **refresh interval** of the link (§9.2).

---

## 9. Sharing a dashboard with a link

### 9.1 The rule: the link sees what **you** see

A share link to a dashboard shows numbers computed with the **current permissions of the person who created the link**, limited to the tables the dashboard's widgets and global filters read. Everyone who opens the link sees the same numbers, whatever their own permissions, and anonymous visitors see them too when the link is public. The share dialog says so before you create the link: "People with the link will see numbers computed with your permissions on N widgets."

- **Widgets added later are shared too**, as long as the link works.
- If you lose access later (to a table, a field, the dashboard, or the right to share), the numbers follow at once: a widget over data you no longer read shows "No permission", and if you can no longer see the dashboard or share, the link stops working.
- Viewers through a link cannot open the records behind a number (no click-through), never see the widgets' saved filters (they are applied, not shown), and never see fields of tables the dashboard does not read. A **records table** widget does show its rows through the link, with the fields you can read: leave such widgets out of a dashboard you share if the rows themselves should stay private.
- Person values show names only (never e-mail addresses); a linked record you cannot read shows no title.

### 9.2 Creating the link

Who: anyone who can see the dashboard **and** may share in the base (base owners and admins, or a role with the **share link** right). Open the dashboard and choose **Share**. As for a view:

- **Who can open**: people **in the organization** (they sign in) or **anyone with the link** (public). Your organization may forbid public links, or allow them only for forms (`public_sharing` policy): then public dashboard links cannot be created, and existing ones stop working until the policy allows them.
- **Password** (6–128 characters; 5 wrong tries lock that visitor out for 15 minutes), **expiry date**, on/off.
- **Copy the link now**: the full address is shown only once. Later, **Create new link** makes a new address and stops the old one.

Settings of a dashboard link:

| Setting | Default | Effect |
| --- | --- | --- |
| **Use the filters** (`settings.dashboard.allow_filter_controls`) | on | Viewers can use the global filters, filter widgets and cross-filtering, only for themselves. Off: the filters are shown as "Filters are turned off for this link." and the API refuses any filter (`403`). |
| **Refresh numbers every** (`settings.dashboard.refresh_seconds`) | 60 s | 30 s, 1, 5 or 15 minutes, or 1 hour in the dialog (30–3,600 s in the API). The page reads the numbers again at this interval **while it is visible** (a hidden tab does not poll), and has a **Refresh** button. |
| **TV mode** (`settings.dashboard.tv_mode`) | off | Viewers can show the dashboard full screen (without rotation: a link has one dashboard). |
| **Download widget data (CSV)** (`settings.allow_export`) | off | Viewers can download each widget as CSV and charts as PNG (§10.2). Disabled when you do not have the download right yourself. |

A link has one target: creating a new link for the same dashboard revokes the previous one. Base admins see and revoke every link of the base in **Share links** of the base settings; organization owners and admins see every link of the organization.

### 9.3 What visitors see

`/s/<token>` shows the dashboard read-only: the same widgets, the filter bar (if allowed), "Updates every …" and **Refresh**. There is no edit mode, no click-through and no people filter. A widget the link cannot read shows "No permission".

| What happens | The visitor sees |
| --- | --- |
| The address is incomplete or wrong | "Link not found" (`404`) |
| The link was revoked, turned off, expired, blocked by the organization's policy, the dashboard was deleted, or its creator lost access or the right to share | "This link is no longer available" (`410`, one answer for every reason) |
| A link for people in the organization, not signed in | The sign-in page, then back to the link |
| A password link | The password screen |
| Too many requests from one address | A short wait (`429`) |

### 9.4 Embedding

A public link without password can also be shown inside another website (the **Embed** tab of the share dialog). See [embedding.md](embedding.md).

---

## 10. Downloading data through a share link

### 10.1 View links: the whole view as CSV or Excel

A share link to a **view** (grid or kanban) can let its visitors download the data: **Download the data (CSV/XLSX)** in the share dialog (`allow_export`, off by default). The dialog says how many records anyone with the link can download, and turning it on for an existing link asks for a confirmation. The share page then has a **Download** button (CSV or Excel (XLSX)).

- **What the file contains**: the view as saved, read with the link creator's **current** permissions, like everything shown through the link. Rows: the view's filter **and** the creator's record rules, records in the trash excluded, in the order of the view (group, then sort). Columns: the fields the creator can read, **minus the fields hidden in the view**. A hidden field is never in the file. Viewers' own filters, sorts and searches are not applied; the export always follows the saved view.
- Values are formatted in the visitor's language (the browser's `Accept-Language`) and time zone. People show only their names (never e-mail addresses), link cells only titles the creator can read, attachments only file names.
- **Conditions**: the link allows exporting **and** its creator has the **download** right of the base now. Without the right, the option is disabled in the dialog ("You cannot download data of this base yourself, so people with the link cannot either") and the API answers `403`, even for a link that had it turned on. Form links cannot export.
- **Row cap**: at most `EXPORT_MAX_ROWS` rows (server setting, default **1,000,000**); a larger view answers `422 EXPORT_TOO_LARGE` before the download starts. One export runs at a time **per link** and **per visitor IP address** (`429` with `Retry-After` otherwise).
- Every export is recorded in the audit log (`export.created`, actor "share link", with the row count; never values).

### 10.2 Dashboard links: widget CSV and PNG

With **Download widget data (CSV)** on, the **…** menu of each widget on the shared dashboard offers **Download as CSV** (the widget's table of numbers, with the visitor's filters if filters are allowed) and **Download as PNG** for charts. The same conditions apply: the creator's current **download** right, one CSV export at a time per link and per IP, an audit entry per export. A CSV has at most 1,000 groups (§4.2); it never contains raw records.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| A colleague does not see the dashboard | Their custom role does not give **View** for it (new dashboards start at **No access**). A base admin opens base settings → Roles → the role → **Dashboards**. |
| "You don't have permission to see this widget's data" | The widget uses a table or field you cannot read, possibly only in its saved filter (§5). Ask a base admin, who can see the widget's settings. |
| Numbers differ between two people | Expected: each viewer sees the records their role lets them read (§5). |
| A filter has a note "is not applied" | §6.4: the filter is on another table, on a field you cannot read, or on a deleted field. |
| "This widget needs to be fixed" | A table or field it uses was deleted. Restore it from the base trash, or edit the widget. |
| "This widget took too long to load" | The query took more than 10 s. Try again; reduce groups (coarser date bucket, range width, lower limit) or add a filter. |
| The widget does not draw and editing says it has too many groups | More than 1,000 groups: choose a coarser bucket or filter. |
| "Someone else changed this dashboard" | Another admin saved in the meantime. Their version is shown; redo your last change. |
| No **Download** items in the widget menu | Your role has no download right in this base (or, on a share link, the link does not allow it or its creator lost the right). |
| The shared page says "This link is no longer available" | The link was revoked, turned off or expired, or its creator lost access to the dashboard or the right to share. Ask for a new link. |
| A shared dashboard does not update | Links have no realtime: the page refreshes every interval of the link, only while visible. Use **Refresh**. |
| "Filters are turned off for this link." | The link's **Use the filters** is off. |

---

## 12. Reference: limits

| Item | Value |
| --- | --- |
| Dashboards per base (not in the trash) | 50 |
| Widgets per dashboard | 30 |
| Dashboard name / description / icon | 1–100 / up to 2,000 / up to 64 characters |
| Widget title | up to 200 characters |
| Grid | 12 columns; widgets 1–12 columns wide, 2–24 rows high; a new widget is 6 × 6 |
| Metrics per widget | KPI and pie: 1; bar and line: 1–5 (1 with series); combo: 2–5; pivot table: 1–5 |
| Groups shown by a chart | default 20, at most 100 (plus "Other") |
| Rows of a table widget | default 10, at most 500; records table: up to 20 fields |
| Groups of one widget query | at most 1,000 (`422 WIDGET_TOO_LARGE`) |
| Query time | 10 s (`504 QUERY_TIMEOUT`, `Retry-After: 5`) |
| Widget queries at once | 4 per person, 20 per API instance; a query that waits more than 10 s answers `504` |
| Text widget | up to 10,000 characters of Markdown |
| Global filters | up to 10, each on up to 20 tables |
| Live filters per request | up to 50 |
| Values listed by a filter widget | 200 at a time; search up to 100 characters |
| View records (click-through) | 50 per page (at most 200), up to 100,000 records deep |
| Theme palette | up to 12 colors |
| Result cache | 5 minutes (never serves numbers older than the last change) |
| Realtime | changes gathered 5 s per dashboard |
| Trash | 30 days |
| Share link refresh | 30–3,600 s, default 60 s |
| Share link widget requests | 120 per 10 s per IP address; 4 widget queries at once per link |
| Share link export (view) | `EXPORT_MAX_ROWS` rows (default 1,000,000); 1 at a time per link and per IP |
| Embedding origins | up to 20 per link ([embedding.md](embedding.md)) |
