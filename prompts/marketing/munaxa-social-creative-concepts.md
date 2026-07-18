# Munaxa Social Image Prompts

Each creative below is copy-paste ready. Every prompt includes the Munaxa logo reference, theme tokens, typography, exclusions, visual direction, and platform sizing.

## Brand & Design Reference

These creatives reproduce the **Munaxa platform UI**, so they pull from the same design-system
source of truth as the product. Keep them in sync with
[`docs/design-system/README.md`](../design-system/README.md),
[`packages/config-tailwind/preset.ts`](../../packages/config-tailwind/preset.ts), and the live
references in [`docs/design-system/`](../design-system/). If the code and a prompt ever disagree,
the code wins.

- **Logo:** [`docs/design-system/logo.png`](../design-system/logo.png) — the transparent, stylised
  ibex in the brand gradient (coral horns → violet base). Reference it by this repo-relative path.
  Never recolor, crop, distort, redraw, or make it mascot-like; scale by height so the ratio holds
  and place it on a plain surface (never on top of the gradient).
- **Surfaces (dark theme — used for all ads):** background `#0B0518`, elevated `#140A2E`,
  card `#1A0F38`, secondary card `#221547`.
- **Brand & accents:** primary violet `#7A3FFF`, light violet `#B97BFF`, coral `#FF8E6E`,
  aqua `#4DF4E1`. Primary gradient `linear-gradient(135deg, #7A3FFF, #B97BFF 60%, #FF8E6E 120%)` —
  reserved for primary actions, active nav, and the logo only.
- **Text:** foreground `#F4F0FF`, muted `#B5ACD4`, dim `#8B83A8`.
- **Typography:** Sora-like display headline, Inter-like body, JetBrains Mono-like numerics
  (numbers, IDs, money). Money is mono, 3-dp JOD, and stays LTR.
- **Bilingual:** EN/AR, RTL-aware layout; numbers, money, IDs, and dates stay LTR inside RTL.
- **Always exclude:** stock photos, children, classrooms, chalkboards, books, graduation caps, and
  any LMS/course-screen imagery. Munaxa is a **School Operating System, not an LMS**.

## Attendance Visuals

### Creative 1
Headline: Know today's attendance before the day gets away.
Caption Text: Present, absent, late, and excused counts in one operating view for school leaders.
Full AI Image Prompt:
```text
Create a premium B2B SaaS social media image for Munaxa, a School Operating System, not an LMS. Use the official Munaxa logo reference at docs/design-system/logo.png as a refined top-left brand mark; preserve its transparent background, full ibex shape, coral-to-violet gradient, horns, and lower curve. Do not recolor, crop, distort, redraw, or make it mascot-like. Use Munaxa tokens: deep ink background #0B0518, elevated surface #140A2E, card #1A0F38, secondary card #221547, primary violet #7A3FFF, light violet #B97BFF, coral #FF8E6E, aqua #4DF4E1, foreground #F4F0FF, muted #B5ACD4, dim #8B83A8. Typography: Sora-like display headline, Inter-like body, JetBrains Mono-like numerics. Visual: dark dashboard card with KPI row for Present, Late, Absent, Excused, compact progress bars, mono counts, aqua for present, coral for late, muted/destructive for absent, violet selected state. Render headline "Know today's attendance before the day gets away." and support text "Present, absent, late, and excused counts in one operating view for school leaders." No stock photos, children, classrooms, chalkboards, books, graduation caps, or LMS imagery. Aspect ratio 1:1, 1200x1200, premium enterprise SaaS ad.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add a thin top label "Attendance Operations" and CTA "See the daily register".
Facebook Version: Use larger headline and fewer KPI labels.

### Creative 2
Headline: Offline marking. Clean sync later.
Caption Text: Teachers can capture attendance even when school connectivity is unreliable.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS social image. Use the official Munaxa logo reference at docs/design-system/logo.png in the top-left with clear space; preserve the ibex coral-to-violet gradient and transparent background, never crop or recolor. Theme tokens: #0B0518 background, #140A2E elevated panels, #1A0F38 cards, #221547 secondary cards, #7A3FFF primary violet, #B97BFF light violet, #FF8E6E coral warnings, #4DF4E1 aqua success, #F4F0FF foreground, #B5ACD4 muted text, #8B83A8 dim text. Sora-like headline, Inter-like body, JetBrains Mono-like metrics. Visual: mobile teacher attendance screen beside an admin register, sync queue badge "3 pending", connectivity restored indicator, violet sync action, aqua saved states, coral late badge, small mono clientRef IDs. Headline: "Offline marking. Clean sync later." Supporting text: "Teachers can capture attendance even when school connectivity is unreliable." No stock-photo education imagery, no children, no classroom. 1:1, 1200x1200, polished dark SaaS campaign.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Write-ahead attendance queue".
Facebook Version: Add "Mark now. Sync when online."

### Creative 3
Headline: One register. Four clear statuses.
Caption Text: Present, absent, late, and excused are visible, filterable, and ready for reporting.
Full AI Image Prompt:
```text
Generate a premium B2B SaaS ad for Munaxa School OS using the official logo at docs/design-system/logo.png, placed top-right on plain #0B0518; keep the stylized ibex gradient intact, transparent, uncropped, and unmodified. Use design tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography should feel like Sora, Inter, and JetBrains Mono for numbers. Visual: segmented attendance controls and roster table with four status chips: PRESENT aqua, ABSENT danger/muted, LATE coral, EXCUSED violet. Include clean filters for Section, Date, Period. Render headline "One register. Four clear statuses." and caption "Present, absent, late, and excused are visible, filterable, and ready for reporting." No photos, students, chalkboards, books, LMS screens. 1200x1200, dark enterprise dashboard style.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Section Register".
Facebook Version: Make the four chips the hero visual.

### Creative 4
Headline: Attendance that respects the teacher's final mark.
Caption Text: Presence automation can support operations without overwriting teacher decisions.
Full AI Image Prompt:
```text
Create a dark premium SaaS image for Munaxa School Operating System. Use official logo reference docs/design-system/logo.png as a small top-left transparent ibex mark; preserve coral-to-violet gradient, no recolor, no crop. Apply tokens: background #0B0518, elevated #140A2E, card #1A0F38, card-2 #221547, violet #7A3FFF, violet light #B97BFF, coral #FF8E6E, aqua #4DF4E1, text #F4F0FF, muted #B5ACD4, dim #8B83A8. Sora-like headline, Inter body, mono timestamps. Visual: split UI panel showing a gate event card and an attendance register; a shield icon and small label "Teacher mark wins"; prior ABSENT row preserved while GATE_IN event appears in timeline. Render headline and supporting text exactly. Avoid stock photos, children, classrooms, generic school symbols, LMS imagery. 1:1 1200x1200, executive trust style.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Non-overwriting attendance logic".
Facebook Version: Main subhead "Automation with control".

### Creative 5
Headline: Gate presence, visible in seconds.
Caption Text: Record gate-in and reception events for a clearer daily operations picture.
Full AI Image Prompt:
```text
Design a premium Munaxa School OS social post using logo reference docs/design-system/logo.png. Place logo top-left, preserve transparent coral-to-violet ibex mark, no cropping or recoloring. Use Munaxa tokens: #0B0518 background, #140A2E elevated, #1A0F38 cards, #221547 secondary, #7A3FFF primary, #B97BFF highlight, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Typography: Sora/Inter/JetBrains Mono feel. Visual: abstract gate line icon, presence event stream cards labeled GATE_IN, GATE_OUT, RECEPTION_CHECKIN, MANUAL, NFC, RFID, aqua timeline nodes, coral exception badge, violet active filter. Headline "Gate presence, visible in seconds." Caption "Record gate-in and reception events for a clearer daily operations picture." No photos, no children, no generic education icons. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Presence & Gate".
Facebook Version: Emphasize "See arrivals as they happen."

### Creative 6
Headline: From bus arrival to attendance context.
Caption Text: Transportation events and presence data help schools understand the morning flow.
Full AI Image Prompt:
```text
Create a Munaxa-branded premium SaaS ad. Use official logo file docs/design-system/logo.png as a refined top-left ibex mark; maintain transparent background and coral-to-violet gradient, never distort. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora-like display, Inter body, mono times. Visual: route line with bus event cards BOARD_AM and ARRIVE_SCHOOL, merged timeline cards for attendance, presence, and transport, aqua arrival badge, coral delay marker, violet route glow. Headline "From bus arrival to attendance context." Support "Transportation events and presence data help schools understand the morning flow." No stock bus photo, no children, no classroom, no LMS. 1:1, 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Presence + transport timeline".
Facebook Version: Use a larger route graphic.

### Creative 7
Headline: Section attendance, without spreadsheet drift.
Caption Text: Load a section, mark the day, and keep the register consistent.
Full AI Image Prompt:
```text
Generate a premium dark SaaS social image for Munaxa School OS. Use official logo reference docs/design-system/logo.png top-left; preserve ibex logo gradient, transparency, horns, and lower curve. Theme: #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary card, #7A3FFF violet, #B97BFF light violet, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Use Sora-like headline, Inter body, JetBrains Mono metrics. Visual: section picker, date input, period input, roster rows with attendance buttons, violet "Save attendance" CTA, aqua present states, coral late states, mono date. Render headline and caption exactly. Exclude stock photos, children, chalkboards, books, LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: CTA "Replace manual registers".
Facebook Version: CTA "Mark the day faster".

### Creative 8
Headline: Parent-ready attendance history.
Caption Text: Attendance history is available for scoped parent and student views.
Full AI Image Prompt:
```text
Create a premium B2B SaaS image for Munaxa, School Operating System. Logo: use docs/design-system/logo.png top-right on plain #0B0518, preserving transparent coral-to-violet ibex mark without edits. Tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Type: Sora-like, Inter-like, JetBrains Mono-like for numbers. Visual: mobile parent dashboard card with Attendance (30d), child switcher, history graph, paired with admin attendance summary; add small lock icon for scoped access and bilingual EN/AR micro-labels. Headline "Parent-ready attendance history." Caption "Attendance history is available for scoped parent and student views." No family photos, classroom images, or generic education art. 1:1, 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Scoped to linked children".
Facebook Version: Use phone mockup centered.

### Creative 9
Headline: Attendance reports that are ready to export.
Caption Text: Turn attendance records into viewable and downloadable reports.
Full AI Image Prompt:
```text
Design a Munaxa School OS social image, premium enterprise SaaS. Use official logo reference docs/design-system/logo.png as small top-left brand mark, preserving original gradient and transparent background. Use colors #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora headline, Inter body, mono report values. Visual: attendance report table with Present, Absent, Late, Excused columns; export buttons CSV, XLSX, PDF; aqua attendance rate, coral absence highlights, violet active tab. Render headline "Attendance reports that are ready to export." and caption. No stock education imagery or LMS content. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Include "CSV / Excel / PDF".
Facebook Version: Feature export buttons.

### Creative 10
Headline: Attendance is more than a checkbox.
Caption Text: Munaxa connects registers, presence, transport, parent visibility, and reports.
Full AI Image Prompt:
```text
Create an executive Munaxa School OS campaign image. Use logo file docs/design-system/logo.png top-left, preserving the full transparent coral-to-violet ibex mark. Use tokens #0B0518 deep ink, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF violet, #B97BFF light violet, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF foreground, #B5ACD4 muted, #8B83A8 dim. Sora-like headline, Inter body, JetBrains Mono metrics. Visual: four connected cards labeled Register, Gate, Bus, Reports with violet connector lines, aqua success badges, coral exception badges. Render headline and caption exactly. No photos, no children, no chalkboards/books/graduation caps, no LMS imagery. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add footer "School OS, not LMS".
Facebook Version: Use four large cards.

## School Operations Visuals

### Creative 11
Headline: Run the school from one operating view.
Caption Text: Structure, people, timetable, attendance, finance, communication, and reports in one system.
Full AI Image Prompt:
```text
Create a premium B2B SaaS ad for Munaxa School Operating System. Use official logo reference docs/design-system/logo.png top-left, transparent gradient ibex preserved, uncropped, unrecolored. Apply tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Type: Sora-like headline, Inter body, JetBrains Mono numbers. Visual: app shell with nav rail listing Dashboard, People, Timetable, Attendance, Finance, Communication, Reports, Modules; central KPI dashboard and recent activity card. Headline "Run the school from one operating view." Caption as provided. No stock photos, students, classrooms, education clichés, or LMS screens. 1200x1200 premium dark enterprise UI.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "School Operating System".
Facebook Version: Show fewer nav items.

### Creative 12
Headline: Permissions built for real school teams.
Caption Text: Principals, finance officers, teachers, reception, HR, clinic, library, and fleet roles stay scoped.
Full AI Image Prompt:
```text
Generate a Munaxa premium SaaS image. Logo reference: docs/design-system/logo.png, placed top-right, original transparent ibex gradient preserved. Munaxa tokens: #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF violet, #B97BFF highlight, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF foreground, #B5ACD4 muted, #8B83A8 dim. Sora/Inter/JetBrains Mono typography. Visual: role-based access matrix with role chips Principal, FinanceOfficer, Teacher, Receptionist, HR, Nurse, Librarian, FleetAdmin; permission strings like attendance:read and finance:manage in mono; aqua allowed, coral restricted, violet selected. Render headline and caption. No people portraits, no school stock imagery, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "RBAC across school and platform planes".
Facebook Version: Use headline "The right access for every role".

### Creative 13
Headline: School structure without the admin maze.
Caption Text: Manage campuses, academic years, semesters, grades, sections, and classrooms.
Full AI Image Prompt:
```text
Create a premium dark Munaxa School OS post with official logo reference docs/design-system/logo.png top-left; preserve transparent coral-violet ibex logo. Use colors #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Fonts: Sora-like, Inter-like, mono metrics. Visual: clean hierarchy diagram made from UI cards: Campus > Academic Year > Semester > Grade > Section > Classroom, violet hierarchy lines, aqua active badges, coral warning badge, mono IDs. Render headline "School structure without the admin maze." and caption. No building stock photos, children, chalkboards, books, LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Structure is the operating backbone".
Facebook Version: Simplify to four hierarchy levels.

### Creative 14
Headline: Timetable clarity for the week ahead.
Caption Text: Resolve schedules, exceptions, holidays, and section views in one place.
Full AI Image Prompt:
```text
Design a Munaxa School OS social graphic using logo file docs/design-system/logo.png as top-left brand mark; preserve gradient ibex logo and clear space. Tokens: background #0B0518, elevated #140A2E, card #1A0F38, secondary #221547, violet #7A3FFF, light violet #B97BFF, coral #FF8E6E, aqua #4DF4E1, text #F4F0FF, muted #B5ACD4, dim #8B83A8. Typography: Sora display, Inter body, JetBrains Mono times. Visual: weekly timetable grid Sun-Thu, class cards, holiday strike-through, exception badge, aqua scheduled states, coral conflict/exception state. Headline and support text exactly. No generic education photos or LMS imagery. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Include "Weekly section view".
Facebook Version: Make timetable grid dominant.

### Creative 15
Headline: Optional modules when the school is ready.
Caption Text: Bus, library, inventory, and clinic can be enabled per tenant.
Full AI Image Prompt:
```text
Create a premium SaaS social image for Munaxa School OS. Use the official logo reference docs/design-system/logo.png top-right; preserve transparent ibex gradient, no recoloring/cropping. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora-like headline, Inter body, mono labels. Visual: feature-flag module panel with four toggle cards: Bus Tracking, Library, Inventory, School Clinic; aqua enabled toggles, muted disabled cards, violet active border, coral caution badge. Render headline and caption. No stock school imagery, no cartoon icons, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Feature-flagged by tenant".
Facebook Version: Use "Enable only what you need".

### Creative 16
Headline: Fleet operations, not guesswork.
Caption Text: Manage routes, stops, buses, assignments, and latest vehicle location.
Full AI Image Prompt:
```text
Generate a premium Munaxa dark SaaS ad. Logo: docs/design-system/logo.png, top-left, original transparent coral-to-violet ibex preserved. Tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Typography: Sora headline, Inter body, JetBrains Mono plate/time values. Visual: fleet dashboard with route card, bus vehicle card with plate and capacity, stop timeline with pickup times, abstract route line, aqua live location ping, coral late marker, violet CTA. Render headline "Fleet operations, not guesswork." and caption. No stock bus photos, no children, no classroom, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Include "Routes, stops, vehicles, assignments".
Facebook Version: Focus on route line and vehicle card.

### Creative 17
Headline: Library, inventory, and clinic in the same operating language.
Caption Text: Keep optional school services structured, permissioned, and easy to scan.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS social post. Use official logo reference docs/design-system/logo.png top-left, transparent gradient ibex preserved, no edits. Theme tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora/Inter/mono typography. Visual: three-column UI composition: Library loans, Inventory movement, Clinic visits; compact tables, badges ACTIVE, OVERDUE, RESOLVED; aqua success, coral warning, mono quantities and temperatures. Headline and caption exactly. No photos, no children, no cartoon school icons, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Advanced modules, feature gated".
Facebook Version: Use three large icon cards.

### Creative 18
Headline: Every school action leaves a trail.
Caption Text: Tenant isolation, permissions, and audit-aware workflows protect operational trust.
Full AI Image Prompt:
```text
Design a premium enterprise SaaS image for Munaxa. Use official logo file docs/design-system/logo.png top-right; preserve the transparent coral-violet ibex mark. Use Munaxa colors #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF violet, #B97BFF light, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Sora headline, Inter body, mono audit rows. Visual: audit log table, role chip, tenant ID, lock/shield line icon, aqua verified state, coral alert state, violet glow on active row. Render headline and caption. No stock people, no school clichés, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Built for multi-tenant school operations".
Facebook Version: Use "Operations with accountability".

### Creative 19
Headline: One dashboard for the morning check-in.
Caption Text: Students, staff, attendance, outstanding balance, collected this month, and e-invoice status.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS dashboard ad. Use logo reference docs/design-system/logo.png in top-left, preserving the original transparent ibex gradient. Tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography: Sora-like display, Inter body, JetBrains Mono numerics. Visual: six compact KPI cards: Students, Staff, Attendance today, Outstanding, Collected (mo), e-Invoice pending; aqua positive metrics, coral outstanding, violet active glow, recent activity list. Render headline and caption. No photos, children, chalkboards, books, LMS. 1200x1200 square.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Executive operating snapshot".
Facebook Version: Use larger KPI grid.

### Creative 20
Headline: School OS, not another disconnected tool.
Caption Text: Munaxa connects administration, finance, attendance, communication, and reporting.
Full AI Image Prompt:
```text
Generate a flagship Munaxa brand image. Use official logo reference docs/design-system/logo.png as central or top-left refined ibex mark; preserve gradient, transparency, horns, lower curve. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Use Sora headline, Inter support, mono metrics. Visual: five UI cards orbiting dashboard: Admin, Attendance, Finance, Communication, Reports, connected by violet lines with aqua/coral badges. Render headline "School OS, not another disconnected tool." and caption. No stock education imagery, no LMS screens. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Purpose-built for school operators".
Facebook Version: Make central headline dominant.

## Parent Communication Visuals

### Creative 21
Headline: Announcements that reach the right audience.
Caption Text: Publish to all users, parents, teachers, students, or a section.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS communication ad. Use official logo docs/design-system/logo.png top-left; keep transparent coral-to-violet ibex logo intact, no recolor/crop. Tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora headline, Inter body, mono recipient count. Visual: announcement composer with Title, Body, Audience selector; chips ALL, PARENTS, TEACHERS, STUDENTS, SECTION; violet publish button, aqua recipient count. Render headline and caption. No chat app screenshots, no stock families, no classrooms, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Audience-based fan-out".
Facebook Version: Make audience selector the hero.

### Creative 22
Headline: Parent updates, recorded in one center.
Caption Text: In-app notifications are the source of truth; push and WhatsApp are delivery channels.
Full AI Image Prompt:
```text
Design a premium SaaS social image for Munaxa. Logo reference docs/design-system/logo.png top-right, original transparent gradient ibex preserved. Use #0B0518 background, #140A2E elevated, #1A0F38 cards, #221547 secondary, #7A3FFF violet, #B97BFF light, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Typography Sora/Inter/mono. Visual: notification center rows, unread count badge, FCM push indicator, optional WhatsApp bridge toggle as feature flag, aqua unread badge, coral disabled warning. Headline and caption exactly. No stock phones in hands, no people, no classroom, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "WhatsApp bridge is feature-flagged".
Facebook Version: Focus on unread count.

### Creative 23
Headline: Multi-child parent views, properly scoped.
Caption Text: Parents see only the children linked to their account.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS parent portal image. Use official logo file docs/design-system/logo.png top-left; preserve transparent coral-violet ibex gradient. Tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora-like headline, Inter body, mono numbers. Visual: mobile child switcher cards and child dashboard metrics: Attendance 30d, Outstanding, Pending leave, Documents, Unread; lock icon for row scoping; bilingual EN/AR micro-labels. Render headline and caption. No family photos, children, classrooms, books, LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Row-scoped parent portal".
Facebook Version: Use one large mobile card.

### Creative 24
Headline: Leave and absence requests without hallway paperwork.
Caption Text: Parents submit requests; staff review and approve with clear status.
Full AI Image Prompt:
```text
Generate a premium Munaxa social ad. Use logo reference docs/design-system/logo.png top-right; preserve transparent gradient ibex mark. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography like Sora, Inter, JetBrains Mono. Visual: parent mobile request form beside admin approval queue; status chips PENDING, APPROVED, REJECTED; violet submit action, aqua approved, coral pending, mono dates. Headline and caption exactly. No paper-form stock photos, no parent/child photos, no classroom, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Parent self-service with staff approval".
Facebook Version: Use "Requests in one workflow".

### Creative 25
Headline: Parent-teacher meetings that respect capacity.
Caption Text: Open slots, book by child, and prevent double-booking.
Full AI Image Prompt:
```text
Create a Munaxa School OS premium SaaS image using logo docs/design-system/logo.png top-left, original transparent coral-to-violet ibex preserved. Theme tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Type: Sora/Inter/mono. Visual: PTM booking UI with slot cards showing teacher, time window, capacity meter, child selector, BOOKED badge, aqua open slot, coral full slot, violet CTA. Render headline and caption. No school hallway photo, no people, no books/chalkboards, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Atomic slot booking".
Facebook Version: Use capacity meter prominently.

### Creative 26
Headline: Documents where parents expect them.
Caption Text: Per-child document vault with scoped access and secure file flow.
Full AI Image Prompt:
```text
Design a premium dark SaaS social post for Munaxa. Use official logo reference docs/design-system/logo.png top-left, transparent gradient ibex intact. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora headline, Inter body, mono metadata. Visual: child profile card with document vault list, upload button, secure link icons, scoped access lock, aqua available status, violet CTA. Headline "Documents where parents expect them." Caption as provided. No folder stock art, no people photos, no classroom, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Include "Per-child vault".
Facebook Version: Emphasize "Documents by child".

### Creative 27
Headline: Communication that does not disappear in chat threads.
Caption Text: Announcements and notifications stay structured by audience and user.
Full AI Image Prompt:
```text
Create a premium B2B SaaS ad for Munaxa School OS. Use official logo at docs/design-system/logo.png top-right; preserve transparent coral-violet ibex. Tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Typography Sora/Inter/JetBrains Mono. Visual: left side abstract messy chat dots fading, right side organized Munaxa notification table and audience chips, violet structure lines, aqua unread count, coral urgent badge. Render headline and caption. No generic messaging screenshots, no parents/children photos, no school clichés, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Structured communication for school operations".
Facebook Version: Use stronger before/after contrast.

### Creative 28
Headline: Parents see attendance, finance, grades, and updates together.
Caption Text: The parent dashboard brings operational context into one mobile view.
Full AI Image Prompt:
```text
Generate a Munaxa premium social image. Logo reference docs/design-system/logo.png top-left, transparent gradient ibex preserved. Design tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Use Sora headline, Inter body, JetBrains Mono JOD and percentages. Visual: parent mobile dashboard cards for Attendance 30d, Outstanding, Recent grades, Upcoming homework, Unread notifications; aqua healthy stats, coral outstanding balance, violet active tab. Render headline and caption. No stock parent image, no children, no classroom, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "One child dashboard, many school signals".
Facebook Version: Center phone mockup.

### Creative 29
Headline: Every audience gets the right message.
Caption Text: Communicate with parents, teachers, students, sections, or the whole school.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS communication visual. Use official logo docs/design-system/logo.png top-left, preserve transparent coral-to-violet ibex mark. Munaxa tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora/Inter/mono typography. Visual: central announcement card branching to recipient group cards Parents, Teachers, Students, Section, All School; violet routing lines, aqua delivered counters, coral section badge. Render headline and caption. No people silhouettes if possible; use minimal line icons. No stock photos or LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Audience resolution by role and section".
Facebook Version: Use "Targeted school updates".

### Creative 30
Headline: Parent communication with operational context.
Caption Text: Reminders, attendance, requests, documents, and notifications connect back to the student record.
Full AI Image Prompt:
```text
Design a premium SaaS post for Munaxa School OS. Use logo reference docs/design-system/logo.png top-right; keep transparent coral-violet ibex untouched. Use tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora headline, Inter body, mono IDs/JOD. Visual: student profile card center connected to payment reminder, attendance history, leave request, document vault, notification cards; violet connectors, aqua status, coral outstanding balance. Render headline and caption. No student photo, no classroom, no generic education art, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Connected to the School OS record".
Facebook Version: Focus on one student profile card.

## Finance & Fee Collection Visuals

### Creative 31
Headline: Know every student's balance in JOD.
Caption Text: Charged, paid, discounts, outstanding, credit, and refunded totals in one statement.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS finance image. Use official logo at docs/design-system/logo.png top-left, preserve transparent coral-to-violet ibex. Tokens: #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography: Sora headline, Inter body, JetBrains Mono for all JOD values to 3 decimals. Visual: finance statement UI with six KPI cards: Charged, Paid, Discounts, Outstanding, Credit, Refunded; aqua paid/credit, coral outstanding, violet selected student. Render headline and caption. No cash stock photos, credit cards, children, classrooms, LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "3-decimal JOD precision".
Facebook Version: Make outstanding and paid cards large.

### Creative 32
Headline: Fee plans become clear charges.
Caption Text: Build reusable fee plans, issue charges, and keep student statements traceable.
Full AI Image Prompt:
```text
Generate a Munaxa premium SaaS finance post. Use official logo reference docs/design-system/logo.png top-right, transparent ibex gradient preserved. Use colors #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora/Inter/mono typography. Visual: fee plan card flowing into charge card and student statement, violet connector, aqua verified badge, mono amount "750.000 JOD", clean ledger rows. Render headline and caption. No coins, no payment stock imagery, no students/classroom, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Fee plans, charges, statements".
Facebook Version: Focus on plan-to-statement flow.

### Creative 33
Headline: Receipt uploads, not payment gateway risk.
Caption Text: Parents upload CliQ or e-wallet receipts; finance verifies before balances update.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS social ad. Use official logo file docs/design-system/logo.png top-left, preserve original transparent coral-violet ibex. Munaxa tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography Sora/Inter/JetBrains Mono. Visual: mobile receipt upload card, pending transaction card, finance verification action; coral PENDING badge, aqua VERIFIED badge, violet upload/verify CTA, mono receipt reference. Render headline and caption. No credit card imagery, cash photos, people, classrooms, LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "No online payment gateway".
Facebook Version: Use "Upload. Verify. Reconcile."

### Creative 34
Headline: Outstanding balance is not a guess.
Caption Text: Munaxa calculates outstanding from active charges minus verified transactions.
Full AI Image Prompt:
```text
Design a premium finance SaaS graphic for Munaxa. Use logo docs/design-system/logo.png top-right, transparent coral-to-violet ibex preserved. Tokens #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF violet, #B97BFF light, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Sora headline, Inter body, mono formula and JOD. Visual: formula card "Active Charges - Verified Payments = Outstanding", ledger rows, aqua verified payments, coral outstanding result. Render headline and caption. No calculator/cash stock photo, no school clichés, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Authoritative ledger calculation".
Facebook Version: Make formula central.

### Creative 35
Headline: Send reminders with the right exclusions.
Caption Text: Due-this-month and overdue reminders can go in-app and by SMS, while legal cases are excluded.
Full AI Image Prompt:
```text
Create a Munaxa premium collections dashboard image. Use official logo reference docs/design-system/logo.png top-left; preserve transparent ibex gradient. Use tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Typography Sora/Inter/mono. Visual: reminder snapshot cards Outstanding, Due This Month, Overdue, channel chips IN_APP and SMS, LEGAL exclusion badge, coral overdue, aqua eligible, violet send button, mono JOD values. Render headline and caption. No angry debt imagery, no cash, no people photos, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Collections flags and reminder logs".
Facebook Version: Use "Remind the right families".

### Creative 36
Headline: Discounts and credit notes stay traceable.
Caption Text: Apply fixed or percentage deductions with a reason and keep the ledger clean.
Full AI Image Prompt:
```text
Generate a premium dark finance UI ad for Munaxa School OS. Use logo file docs/design-system/logo.png top-right, preserving transparent coral-violet ibex. Use #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora headline, Inter body, JetBrains Mono money. Visual: adjustment modal with amount, percent, reason; discount badge, credit memo row, aqua credit note, coral validation warning, violet apply CTA. Render headline and caption. No generic discount tags, no cash, no students/classroom, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Structured adjustments".
Facebook Version: Use large adjustment card.

### Creative 37
Headline: Allocate payments where they belong.
Caption Text: Verified payments can be applied to one or more charges with clear remaining balances.
Full AI Image Prompt:
```text
Create a premium Munaxa School OS ledger image. Use official logo reference docs/design-system/logo.png top-left, transparent gradient ibex intact. Theme #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora/Inter/mono typography. Visual: verified payment row splitting into multiple charge rows with allocation amounts, remaining balance chips, violet connector lines, aqua allocated status, coral over-allocation guard. Render headline and caption. No payment stock photo, no people, no classroom, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Manual allocation with balance guards".
Facebook Version: Use "Match payments to charges".

### Creative 38
Headline: JoFotara e-invoicing connected to school fees.
Caption Text: Issue fee invoices and credit notes through the finance bridge when configured.
Full AI Image Prompt:
```text
Design a premium Munaxa e-invoicing social post. Use logo docs/design-system/logo.png top-right, preserve transparent coral-violet ibex logo. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography Sora, Inter, JetBrains Mono. Visual: finance charge card connected to JoFotara invoice document card, QR placeholder, status ACCEPTED, queue state, mono invoice number FEE-XXXX, aqua accepted badge, coral rejected small state, violet document glow. Render headline and caption. Do not imitate government logos, no cash photos, no classroom/LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Jordan-ready e-invoicing workflow".
Facebook Version: Use "Fees to e-invoices".

### Creative 39
Headline: Refunds with available-credit checks.
Caption Text: Refund requests stay tied to verified credit and finance review.
Full AI Image Prompt:
```text
Create a premium Munaxa finance image. Use official logo file docs/design-system/logo.png top-left, preserving transparent gradient ibex mark. Tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora-like headline, Inter body, mono JOD values. Visual: available credit card, pending refund card, verify/reject actions, aqua credit balance, coral pending status, violet primary button, clear ledger row. Render headline and caption. No cash or banknote imagery, no people, no school clichés, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Credit balance controls".
Facebook Version: Use "Refunds without ledger drift".

### Creative 40
Headline: Finance reports for principals and finance teams.
Caption Text: View and export financial summaries alongside attendance, academic, and behavior data.
Full AI Image Prompt:
```text
Generate a premium Munaxa School OS reporting image. Logo reference docs/design-system/logo.png top-right, transparent coral-to-violet ibex preserved. Use colors #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora headline, Inter body, mono JOD. Visual: financial report table with charged, paid, outstanding columns, export buttons CSV XLSX PDF, violet active tab, aqua paid, coral outstanding. Render headline and caption. No spreadsheet stock photo, no people/classroom, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Export-ready reporting".
Facebook Version: Feature export buttons.

## Leadership & Growth Visuals

### Creative 41
Headline: Give school leaders an operating system, not more tabs.
Caption Text: Munaxa brings daily operations into one executive-grade dashboard.
Full AI Image Prompt:
```text
Create a flagship premium B2B SaaS ad for Munaxa. Use official logo reference docs/design-system/logo.png top-left, preserving transparent coral-to-violet ibex mark. Design tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography: Sora headline, Inter support, JetBrains Mono metrics. Visual: executive dashboard with nav rail and KPI cards for attendance, finance, communication, reports, activity; subtle violet glow, aqua healthy states, coral risk states. Render headline and caption. No stock photos, children, classroom, education clichés, LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "For owners, directors, principals, and administrators".
Facebook Version: Use bolder headline.

### Creative 42
Headline: Scale schools with tenant-aware operations.
Caption Text: Platform and school planes keep cross-tenant and single-school work separated.
Full AI Image Prompt:
```text
Design a premium Munaxa multi-tenant SaaS visual. Use logo docs/design-system/logo.png top-right, transparent gradient ibex intact. Use tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora/Inter/mono typography. Visual: two planes labeled Platform plane and School plane, tenant database cards, role chips, lock icons, aqua isolated tenant badges, mono tenant IDs, violet hierarchy lines. Render headline and caption. No school building stock photos, no children/classrooms, no LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Built for multi-school operations".
Facebook Version: Use "Separate every school's data".

### Creative 43
Headline: Reports that turn operations into decisions.
Caption Text: Attendance, academic, financial, and behavior summaries feed leadership reviews.
Full AI Image Prompt:
```text
Create a premium Munaxa leadership reporting image. Use official logo reference docs/design-system/logo.png top-left, preserve transparent coral-violet ibex. Theme tokens: #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora headline, Inter body, mono generated timestamp. Visual: four report tabs Attendance, Academic, Financial, Behavior; clean table, small charts, export controls, aqua improvement metric, coral risk metric, violet active tab. Render headline and caption. No boardroom photo, no people, no classroom, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "CSV, Excel, PDF".
Facebook Version: Use "Decisions from school data".

### Creative 44
Headline: A calmer way to manage school complexity.
Caption Text: Roles, modules, reports, communication, and finance work from one design language.
Full AI Image Prompt:
```text
Generate a premium Munaxa School OS brand visual. Use official logo file docs/design-system/logo.png top-right, transparent gradient ibex preserved. Use #0B0518 background, #140A2E elevated, #1A0F38 card, #221547 secondary, #7A3FFF violet, #B97BFF light, #FF8E6E coral, #4DF4E1 aqua, #F4F0FF text, #B5ACD4 muted, #8B83A8 dim. Sora headline, Inter support, mono micro-labels. Visual: five balanced UI cards: Roles, Modules, Reports, Communication, Finance, with restrained violet glow and aqua/coral status badges. Render headline and caption. No photos or generic education art. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Operational clarity for leadership teams".
Facebook Version: Use "Complexity, organized."

### Creative 45
Headline: Built for bilingual school operations.
Caption Text: English and Arabic interfaces, RTL-aware layout, and LTR numerics for IDs and money.
Full AI Image Prompt:
```text
Create a premium Munaxa bilingual SaaS image. Use logo reference docs/design-system/logo.png top-left, transparent coral-to-violet ibex untouched. Tokens #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora-like headline, Inter-like body, JetBrains Mono numerics. Visual: mirrored LTR/RTL dashboard panels, EN/AR toggle, Arabic microcopy, JOD and IDs staying LTR in mono, violet active toggle, aqua status badges, coral accent. Render headline and caption. No flags, stereotypes, stock photos, classrooms, LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "RTL-safe by design".
Facebook Version: Use bigger EN/AR toggle.

### Creative 46
Headline: Fewer blind spots before the month closes.
Caption Text: Attendance, collections, reports, and activity help leaders see operational risk early.
Full AI Image Prompt:
```text
Design a premium executive dashboard ad for Munaxa School OS. Use official logo docs/design-system/logo.png top-right; preserve transparent gradient ibex mark. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Typography Sora/Inter/mono. Visual: risk dashboard with cards Attendance rate, Overdue fees, Recent activity, Pending e-invoices; coral risk markers, aqua healthy markers, violet dashboard glow, mono numbers. Render headline and caption. No stock analytics photos, people, classrooms, LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "See risk before it becomes rework".
Facebook Version: Use "Spot issues earlier".

### Creative 47
Headline: Optional growth modules, controlled rollout.
Caption Text: Enable bus, library, inventory, and clinic only when each school needs them.
Full AI Image Prompt:
```text
Create a premium Munaxa feature rollout visual. Use logo docs/design-system/logo.png top-left, preserving transparent coral-violet ibex. Tokens: #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Sora headline, Inter body, mono labels. Visual: roadmap-style module toggles with tenant cards for Bus Tracking, Library, Inventory, School Clinic; violet rollout path, aqua enabled states, muted disabled states, coral caution badge. Render headline and caption. No stock school imagery, children, classrooms, LMS. 1:1 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Disabled by default, enabled by tenant".
Facebook Version: Use "Grow without clutter".

### Creative 48
Headline: School data, scoped by role.
Caption Text: Leadership sees the whole picture while staff see the workflows they own.
Full AI Image Prompt:
```text
Generate a premium Munaxa School OS role-scoped dashboard image. Use official logo reference docs/design-system/logo.png top-right, transparent gradient ibex preserved. Use colors #0B0518 #140A2E #1A0F38 #221547 #7A3FFF #B97BFF #FF8E6E #4DF4E1 #F4F0FF #B5ACD4 #8B83A8. Typography Sora/Inter/JetBrains Mono. Visual: four role cards: Principal overview, Finance officer statement, Teacher attendance, Receptionist presence; permission chips, aqua allowed states, coral restricted chips, violet card borders. Render headline and caption. No portraits, no classroom imagery, no LMS. Square 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "RBAC for real school teams".
Facebook Version: Use four-role card layout.

### Creative 49
Headline: Digital transformation that starts with operations.
Caption Text: Munaxa modernizes the daily workflows schools already run.
Full AI Image Prompt:
```text
Create a premium Munaxa digital transformation image. Use logo docs/design-system/logo.png top-left, original transparent coral-to-violet ibex intact. Use tokens #0B0518, #140A2E, #1A0F38, #221547, #7A3FFF, #B97BFF, #FF8E6E, #4DF4E1, #F4F0FF, #B5ACD4, #8B83A8. Sora headline, Inter body, mono metrics. Visual: abstract manual forms transforming into Munaxa UI cards for attendance, finance, communication, reports; violet transformation path, aqua completed state, coral exception badge. Render headline and caption. No literal paper piles, no office stock photo, no children/classrooms, no LMS. 1200x1200.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add "Admin-first transformation".
Facebook Version: Use "From manual work to managed workflows".

### Creative 50
Headline: The operating layer for modern schools.
Caption Text: Munaxa connects administration, finance, attendance, communication, mobile portals, and reporting.
Full AI Image Prompt:
```text
Create a flagship premium B2B SaaS campaign image for Munaxa School Operating System. Use the official Munaxa logo reference docs/design-system/logo.png as a refined top-left brand anchor; preserve the transparent stylized ibex mark, coral-to-violet gradient, horns, lower curve, and elegant line quality. Do not recolor, crop, distort, redraw, or make it mascot-like. Use Munaxa tokens: deep ink #0B0518, elevated #140A2E, card #1A0F38, secondary #221547, violet #7A3FFF, light violet #B97BFF, coral #FF8E6E, aqua #4DF4E1, foreground #F4F0FF, muted #B5ACD4, dim #8B83A8. Typography: Sora-like headline, Inter-like body, JetBrains Mono-like metrics. Visual: central premium dashboard floating with five surrounding product cards: Administration, Finance, Attendance, Communication, Mobile Portals, Reporting; violet primary glow, aqua success states, coral attention states, mono KPIs. Render headline "The operating layer for modern schools." and caption. No stock photos, children, classrooms, chalkboards, books, graduation caps, or LMS/course screens. Aspect ratio 1:1, 1200x1200, polished dark enterprise SaaS advertising.
```
Recommended Dimensions: 1200x1200
LinkedIn Version: Add footer "School Operating System, not LMS".
Facebook Version: CTA "Run school operations with Munaxa".
