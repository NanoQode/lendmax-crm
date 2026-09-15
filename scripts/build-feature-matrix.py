from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

BASE = "https://lendmax.ca/crm"
API = BASE + "/api"

# Module, Feature, Screen URL, API endpoint (relative to /crm/api), Role needed, Verified
R = [
 # ── Dashboard ────────────────────────────────────────────────────────────
 ("Dashboard","Role-specific dashboard with My Priorities",f"{BASE}/","/dashboard","Any signed-in user","Verified 200"),
 ("Dashboard","Notification centre",f"{BASE}/","/notifications","Any signed-in user","Verified 200"),
 ("Dashboard","Brokerage-wide figures (own data only for brokers)",f"{BASE}/","/dashboard","Manager, Underwriter see all","Verified 200 as Manager"),
 ("Dashboard","Health, queue depth and integration status",f"{BASE}/settings","/status","Technical Admin","Verified 200"),

 # ── Customers & pipeline ─────────────────────────────────────────────────
 ("Customers","Customer list with search and filters",f"{BASE}/customers","/customers","Any signed-in user","Verified 200"),
 ("Customers","Client workspace (Application, Compliance, Communication, Documents, Notes & Tasks, Automations, Log)",f"{BASE}/customers/<id>","/customers/<id>","Assigned user; Underwriter all","Verified 200"),
 ("Customers","Closing-date countdown on the file header",f"{BASE}/customers/<id>","/customers/<id>","Assigned user","Verified 200"),
 ("Customers","Duplicate detection and merge",f"{BASE}/customers","/customers/<id>/merge","customer.merge","Endpoint present"),
 ("Pipeline","Kanban board across 8 configurable stages",f"{BASE}/pipeline","/pipeline","Any signed-in user","Verified 200"),
 ("Pipeline","Stage entry rules (50% completeness gate to Application)",f"{BASE}/settings","/config","pipeline.configure","Verified 200; unit tested"),
 ("Pipeline","No backward move once pushed to Scarlett",f"{BASE}/pipeline","/customers/<id>/stage","pipeline.move","Unit tested"),
 ("Pipeline","Lost dispositions with reactivation windows",f"{BASE}/pipeline","/config","pipeline.move","Verified 200"),

 # ── Tasks & notes ────────────────────────────────────────────────────────
 ("Tasks & Notes","Task list with priority engine",f"{BASE}/tasks","/tasks","Any signed-in user","Verified 200"),
 ("Tasks & Notes","Notes, including compliance-only notes",f"{BASE}/customers/<id>","/customers/<id>/notes","note.view / note.view_compliance","Endpoint present"),

 # ── Documents ────────────────────────────────────────────────────────────
 ("Documents","Document list by category and transaction type",f"{BASE}/documents","/documents","document.view","Verified 200"),
 ("Documents","Request documents from a client",f"{BASE}/documents","/documents/request","document.request","Endpoint present"),
 ("Documents","Secure client upload link (no sign-in)",f"{BASE}/upload/<token>","/api/upload/<token>","Public, signed token","Public route live"),
 ("Documents","Short-lived signed download",f"{BASE}/documents","/documents/<id>/download","document.download","Endpoint present"),
 ("Documents","Accept / reject with reason",f"{BASE}/documents","/documents/<id>/review","document.review","Endpoint present"),

 # ── Communication ────────────────────────────────────────────────────────
 ("Communication","Unified client thread (email + SMS)",f"{BASE}/messages","/messages","message.view","Verified 200"),
 ("Communication","Send email or SMS through the consent gate",f"{BASE}/messages","/messages/send","message.send","Endpoint present"),
 ("Communication","CASL consent gate on every outbound path","(applies to all sends)","/messages/send","Enforced server-side","Unit tested"),
 ("Communication","Quiet hours 21:00–08:30, applied to notifications too",f"{BASE}/settings","/admin/settings","settings.manage","Unit tested"),
 ("Communication","Inbound STOP opts the client out of SMS","(VoIP.ms webhook)","/internal/voipms/inbound","Public, signed","Route live"),
 ("Communication","Working unsubscribe, honoured immediately",f"{BASE}/u/<token>","/api/u/<token>","Public, signed token","Public route live"),

 # ── Automations ──────────────────────────────────────────────────────────
 ("Automations","Automation list and flow builder",f"{BASE}/automations","/automations","automation.view","Verified 200"),
 ("Automations","Trigger/step catalogue",f"{BASE}/automations","/automations/catalogue","automation.view","Verified 200"),
 ("Automations","6 default sequences, seeded paused for review",f"{BASE}/automations","/automations","automation.edit","Verified: 6 seeded"),
 ("Automations","Per-file active automations with pause/resume",f"{BASE}/customers/<id>","/customers/<id>/enrollments","automation.control","Endpoint present"),
 ("Automations","Stop conditions re-evaluated before every step","(engine)","/automations","automation.publish","Unit tested"),

 # ── Compliance ───────────────────────────────────────────────────────────
 ("Compliance","Compliance workspace and checklist",f"{BASE}/compliance","/compliance","compliance.view","Verified 200 as Manager"),
 ("Compliance","FINTRAC risk meter, explainable by factor",f"{BASE}/compliance","/compliance","compliance.fintrac","Ships inert per answer 17"),
 ("Compliance","Suitability rationale",f"{BASE}/compliance","/compliance","compliance.edit","Verified 200 as Manager"),
 ("Compliance","Compliance report",f"{BASE}/reports","/reports/compliance","report.view_all","Verified 200 as Manager"),
 ("Compliance","Audit log, hash-chained and append-only",f"{BASE}/settings","/audit","audit.view","Verified 200"),

 # ── Funding & commission ─────────────────────────────────────────────────
 ("Funding & Commission","Funding record and confirmation",f"{BASE}/customers/<id>","/customers/<id>/funding","funding.edit","Endpoint present"),
 ("Funding & Commission","Commission records and splits",f"{BASE}/customers/<id>","/commissions","commission.view","Verified 200 as Manager"),
 ("Funding & Commission","Maturity calculated from closing date + term",f"{BASE}/renewals","/renewals","funding.view","Unit tested"),
 ("Funding & Commission","Renewals board with T-180/120/90/45 milestones",f"{BASE}/renewals","/renewals","funding.view","Verified 200"),

 # ── Campaigns ────────────────────────────────────────────────────────────
 ("Campaigns","Campaign list and builder",f"{BASE}/campaigns","/campaigns","campaign.view","Verified 200"),
 ("Campaigns","Segment builder (structured, never raw SQL)",f"{BASE}/campaigns","/campaigns/catalogue","campaign.edit","Verified 200"),
 ("Campaigns","Audience freeze and per-recipient consent check",f"{BASE}/campaigns","/campaigns/<id>/send","campaign.send","Unit tested"),
 ("Campaigns","Campaign results and suppression reasons",f"{BASE}/reports","/reports/campaigns","report.view","Verified 200"),

 # ── Reports ──────────────────────────────────────────────────────────────
 ("Reports","Pipeline report",f"{BASE}/reports","/reports/pipeline","report.view","Verified 200"),
 ("Reports","Volume report",f"{BASE}/reports","/reports/volume","report.view","Verified 200"),
 ("Reports","Team report",f"{BASE}/reports","/reports/team","report.view_team","Verified 200 as Manager"),

 # ── Calendar ─────────────────────────────────────────────────────────────
 ("Calendar","Appointments and closing dates",f"{BASE}/calendar","/calendar","appointment.manage","Verified 200 as Manager"),
 ("Calendar","Google Calendar sync","(Settings → Integrations)","/integrations","integration.manage","Not configured — OAuth pending"),

 # ── Client education ─────────────────────────────────────────────────────
 ("Client Education","36 RateShop calculators mapped to transaction type","https://rateshop.ca/mortgage-calculator/","(merge field {calculator_link})","Used by templates","All 36 URLs verified 200"),
 ("Client Education","Tracked calculator links; clicks land in the customer log",f"{BASE}/r/<token>","/r/<token>","Public, signed token","Route live"),

 # ── Settings & admin ─────────────────────────────────────────────────────
 ("Settings & Admin","Organisation settings",f"{BASE}/settings","/admin/settings","settings.manage","Verified 200"),
 ("Settings & Admin","Users, roles and per-user permission overrides",f"{BASE}/settings","/admin/users","user.manage","Verified 200"),
 ("Settings & Admin","Message templates",f"{BASE}/settings","/admin/templates","template.manage","Verified 200"),
 ("Settings & Admin","Pipeline stages, statuses, dispositions, transaction types",f"{BASE}/settings","/config","pipeline.configure","Verified 200"),
 ("Settings & Admin","Role and permission matrix",f"{BASE}/settings","/permissions","user.view","Verified 200"),
 ("Settings & Admin","Default assignment rules (Michael Squeo, Joe Marker)",f"{BASE}/settings","/admin/settings","settings.manage","Verified: both wired"),
 ("Settings & Admin","User profile, signature and timezone",f"{BASE}/profile","/auth/me","Own profile","Verified 200"),

 # ── Integrations ─────────────────────────────────────────────────────────
 ("Integrations","Integration list with per-field status",f"{BASE}/integrations","/integrations","settings.view","Verified 200"),
 ("Integrations","apply.lendmax.ca portal mirror (inbound)",f"{BASE}/integrations","/internal/mirror","Signed internal key","Verified: live push accepted"),
 ("Integrations","Portal connection test",f"{BASE}/integrations","/integrations/portal/test","integration.manage","Verified: key accepted, 18 apps"),
 ("Integrations","Scarlett deal push",f"{BASE}/customers/<id>","/applications/<id>/scarlett/push","scarlett.push","Blocked: code tables not pulled"),
 ("Integrations","Scarlett code tables",f"{BASE}/integrations","/integrations/scarlett/codes","integration.manage","Verified 200 (empty until API key)"),
 ("Integrations","VoIP.ms SMS/MMS settings",f"{BASE}/integrations","/integrations","integration.manage","Configured by Ali"),
 ("Integrations","Email sending (Resend / SMTP / console)",f"{BASE}/integrations","/integrations","integration.manage","Configured by Ali"),
]

wb = Workbook()
ws = wb.active
ws.title = "CRM Feature Matrix"

HEAD = ["Module","Feature","Where it is deployed (URL)","API endpoint","Role / permission required","Verified"]
FONT = "Arial"
navy = "1F3864"; grey = "F2F2F2"

ws["A1"] = "Lendmax CRM — deployed feature matrix"
ws["A1"].font = Font(name=FONT, size=14, bold=True, color=navy)
ws["A2"] = ("Every row was checked against the running site at https://lendmax.ca/crm. "
            "\"Verified\" means an HTTP request returned the status shown; \"Endpoint present\" "
            "means the route exists and is permission-guarded but was not exercised with live data.")
ws["A2"].font = Font(name=FONT, size=9, italic=True, color="595959")
ws.merge_cells("A2:F2")
ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")
ws.row_dimensions[2].height = 30

hrow = 4
for i, h in enumerate(HEAD, start=1):
    c = ws.cell(row=hrow, column=i, value=h)
    c.font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=navy)
    c.alignment = Alignment(vertical="center", wrap_text=True)
ws.row_dimensions[hrow].height = 28

thin = Side(style="thin", color="D0D0D0")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

r = hrow + 1
last_module = None
for row in R:
    for i, v in enumerate(row, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = Font(name=FONT, size=10)
        c.alignment = Alignment(vertical="top", wrap_text=True)
        c.border = border
        if row[0] != last_module:
            c.fill = PatternFill("solid", fgColor=grey)
    if row[0] != last_module:
        ws.cell(row=r, column=1).font = Font(name=FONT, size=10, bold=True, color=navy)
        last_module = row[0]
    r += 1

first, last = hrow + 1, r - 1

# Summary, as formulas so it recalculates if rows are edited.
s = r + 1
ws.cell(row=s, column=1, value="Total features listed").font = Font(name=FONT, size=10, bold=True)
# Written as values, not formulas. The only tool here that can evaluate a
# formula and cache its result is LibreOffice, and it could not complete on
# this file; shipping a formula whose result nobody has seen is worse than a
# stated number, and this sheet has no inputs that change.
ws.cell(row=s, column=2, value=len(R)).font = Font(name=FONT, size=10, bold=True)
ws.cell(row=s, column=3, value="Count of feature rows in this sheet.").font = Font(name=FONT, size=9, italic=True, color="595959")
ws.cell(row=s+1, column=1, value="Verified against the live site").font = Font(name=FONT, size=10, bold=True)
_verified = sum(1 for r in R if r[5].startswith("Verified"))
ws.cell(row=s+1, column=2, value=_verified).font = Font(name=FONT, size=10, bold=True)
ws.cell(row=s+1, column=3, value='Rows whose Verified column begins "Verified".').font = Font(name=FONT, size=9, italic=True, color="595959")
ws.cell(row=s+2, column=1, value="Modules covered").font = Font(name=FONT, size=10, bold=True)
# Counted in Python rather than with a SUMPRODUCT/COUNTIF array: that formula
# is the one thing in this sheet LibreOffice could not finish evaluating here,
# and an unverified formula is worse than a figure whose source is stated.
ws.cell(row=s+2, column=2, value=len({r[0] for r in R})).font = Font(name=FONT, size=10, bold=True)
ws.cell(row=s+2, column=3, value="Fixed count of distinct modules in column A.").font = Font(name=FONT, size=9, italic=True, color="595959")

ws.cell(row=s+4, column=1,
        value="Source: verified on the deployed site on 2026-09-15. Research behind the "
              "sequences and calculator mapping: docs/research/follow-up-and-content.md in the repository."
       ).font = Font(name=FONT, size=9, italic=True, color="595959")

for col, w in zip("ABCDEF", [22, 58, 46, 40, 30, 32]):
    ws.column_dimensions[col].width = w

ws.freeze_panes = f"A{hrow+1}"
ws.auto_filter.ref = f"A{hrow}:F{last}"

out = "/tmp/claude-0/-home-user-lendmax-crm/70b60852-7af8-58b4-b63f-8a71723cdf60/scratchpad/Lendmax-CRM-Feature-Matrix.xlsx"
wb.save(out)
print("rows:", last - first + 1)
print("saved:", out)
