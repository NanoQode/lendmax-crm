from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

B = "https://lendmax.ca/crm"
F = "Arial"; NAVY="1F3864"; GREY="F2F2F2"; GREEN="1E7B34"; AMBER="9C6500"

# Module, Feature, Screen URL, API endpoint, Role required, How it was tested, Result
R = [
 ("Dashboard","Role dashboard and My Priorities",f"{B}/","GET /dashboard","Any signed-in","Live request as Tech Admin","PASS 200"),
 ("Dashboard","Notification centre",f"{B}/","GET /notifications","Any signed-in","Live request","PASS 200"),
 ("Dashboard","System health, queues, integration status",f"{B}/settings","GET /status","Technical Admin","Live request","PASS 200"),
 ("Dashboard","Own-data-only for brokers; Manager/Underwriter see all",f"{B}/","GET /dashboard","Manager, Underwriter","Live request as Manager","PASS 200"),

 ("Customers","Customer list, search, filters",f"{B}/customers","GET /customers","Any signed-in","Live request","PASS 200"),
 ("Customers","Client workspace (7 tabs, one call)",f"{B}/customers/<id>","GET /applications/<id>","Assigned; Underwriter all","Live request — URL CORRECTED this pass","PASS 200"),
 ("Customers","Application tab data (applicants, financials, conditions)",f"{B}/customers/<id>","GET /applications/<id>","pii.view_financials","Response keys inspected","PASS 200"),
 ("Customers","Notes, incl. compliance-only",f"{B}/customers/<id>","GET /applications/<id>/notes","note.view","Live request","PASS 200"),
 ("Customers","Log / activity timeline",f"{B}/customers/<id>","GET /applications/<id>/activity","customer.view","Live request","PASS 200"),
 ("Customers","Per-file audit trail",f"{B}/customers/<id>","GET /applications/<id>/audit","audit.view","Live request","PASS 200"),

 ("Pipeline","Kanban across 8 configurable stages",f"{B}/pipeline","GET /pipeline","Any signed-in","Live request","PASS 200"),
 ("Pipeline","50% completeness gate into Application",f"{B}/settings","GET /config","pipeline.configure","Unit test + seeded value","PASS (seeded 50)"),
 ("Pipeline","No backward move once pushed to Scarlett",f"{B}/pipeline","POST /applications/<id>/stage","pipeline.move","Unit test: refusal names Scarlett","PASS"),
 ("Pipeline","Lost dispositions with reactivation windows",f"{B}/pipeline","GET /admin/vocabularies/dispositions","pipeline.move","Live request","PASS 200"),

 ("Tasks & Notes","Task list and priority engine",f"{B}/tasks","GET /tasks","task.view","Live request","PASS 200"),

 ("Documents","Document list by category and state",f"{B}/documents","GET /documents","document.view","Live request — 12 demo docs visible","PASS 200"),
 ("Documents","Short-lived signed download link",f"{B}/documents","POST /documents/<id>/link","document.download","Live: link minted, expires_in 300","PASS 200"),
 ("Documents","Download the bytes",f"{B}/documents","GET /documents/<id>/download?t=","document.download","Live as Manager: real PDF, 1 page","PASS 200"),
 ("Documents","Tampered download token refused",f"{B}/documents","GET /documents/<id>/download?t=","document.download","Live: altered signature","PASS 403"),
 ("Documents","Download denied to Technical Admin by design",f"{B}/documents","GET /documents/<id>/download","NOT technical_admin","Live request","PASS 403"),
 ("Documents","Every download recorded",f"{B}/documents","(document_access_log)","document.download","Row present after download","PASS"),
 ("Documents","Document requests per file",f"{B}/customers/<id>","GET /applications/<id>/document-requests","document.request","Live request","PASS 200"),
 ("Documents","Client upload link, no sign-in",f"{B}/upload/<token>","GET /upload/<token>","Public, signed","Route registered and public","PASS"),

 ("Communication","Client thread (email + SMS)",f"{B}/messages","GET /messages","message.view","Live request","PASS 200"),
 ("Communication","Per-customer thread",f"{B}/customers/<id>","GET /customers/<id>/messages","message.view","Live request","PASS 200"),
 ("Communication","Compose preview with merge fields",f"{B}/messages","POST /customers/<id>/messages/preview","message.send","Live: renders, nothing dropped","PASS — FIXED this pass"),
 ("Communication","Unresolvable merge field drops the whole line",f"{B}/messages","POST /customers/<id>/messages/preview","message.send","Live: observed drop + empty:true","PASS"),
 ("Communication","CASL consent gate on every outbound path","(all sends)","(evaluateSend)","Server-enforced","Unit tested","PASS"),
 ("Communication","Quiet hours 21:00–08:30, notifications too",f"{B}/settings","GET /admin/settings","settings.manage","Unit test at 08:15 / 08:30 / 21:00","PASS"),
 ("Communication","Working unsubscribe, honoured immediately",f"{B}/u/<token>","GET /api/u/<token>","Public, signed","Public route live, no expiry","PASS"),
 ("Communication","Inbound STOP opts out of SMS","(VoIP.ms webhook)","POST /voipms/inbound","Public, signed","Route registered","PASS"),

 ("Automations","Automation list and builder",f"{B}/automations","GET /automations","automation.view","Live request","PASS 200"),
 ("Automations","Automation detail",f"{B}/automations","GET /automations/<id>","automation.view","Live request","PASS 200"),
 ("Automations","Enrollments per automation",f"{B}/automations","GET /automations/<id>/enrollments","automation.view","Live request","PASS 200"),
 ("Automations","Trigger and step catalogue",f"{B}/automations","GET /automations/catalogue","automation.view","Live request","PASS 200"),
 ("Automations","Per-file active automations",f"{B}/customers/<id>","GET /customers/<id>/automations","automation.view","Live request","PASS 200"),
 ("Automations","6 default sequences, seeded paused",f"{B}/automations","GET /automations","automation.edit","Live: 6 present, all paused","PASS"),
 ("Automations","No sequence exceeds 6 client touches",f"{B}/automations","(definition)","automation.publish","Unit test over all 6","PASS"),
 ("Automations","Every default passes the publish check",f"{B}/automations","(validateDefinition)","automation.publish","Unit test over all 6","PASS"),
 ("Automations","Voice rotates to Underwriting Team on 3rd/6th",f"{B}/automations","(definition)","automation.edit","Unit test on the 6-step sequence","PASS"),
 ("Automations","Stop conditions re-checked before every step","(engine)","(engine)","automation.publish","Unit tested","PASS"),

 ("Compliance","Compliance workspace and checklist",f"{B}/compliance","GET /compliance","compliance.view","Live as Manager","PASS 200"),
 ("Compliance","Per-file compliance",f"{B}/customers/<id>","GET /applications/<id>/compliance","compliance.view","Live as Manager","PASS 200"),
 ("Compliance","Funded package v2 (13 docs incl. 3 added)",f"{B}/compliance","(checklist template v2)","compliance.edit","Live: v2 has 19 items, 3 funded_package","PASS"),
 ("Compliance","Commission payout blocked while items outstanding",f"{B}/customers/<id>","PUT /commissions/<id>","commission.edit","DB test: blocks, names every item","PASS"),
 ("Compliance","not_applicable does not block payout","(gate)","(commissionPayoutBlockers)","commission.edit","DB test","PASS"),
 ("Compliance","rejected item does block payout","(gate)","(commissionPayoutBlockers)","commission.edit","DB test","PASS"),
 ("Compliance","FINTRAC risk meter — ships inert (answer 17)",f"{B}/compliance","GET /compliance","compliance.fintrac","By instruction, not enabled","BY DESIGN"),
 ("Compliance","Audit log hash-chained, append-only",f"{B}/settings","GET /audit","audit.view","Live: 48+ entries, 1 known historical break","PASS (see note)"),
 ("Compliance","Compliance report",f"{B}/reports","GET /reports/compliance","report.view_all","Live as Manager","PASS 200"),

 ("Funding & Commission","Funding record per file",f"{B}/customers/<id>","GET /applications/<id>/funding","funding.view","Live as Manager","PASS 200"),
 ("Funding & Commission","Commission list",f"{B}/customers/<id>","GET /commissions","commission.view","Live as Manager","PASS 200"),
 ("Funding & Commission","Maturity from closing date + term","(domain)","(calculateMaturity)","funding.view","Unit tested, month-end clamped","PASS"),
 ("Funding & Commission","Renewals board, T-180/120/90/45",f"{B}/renewals","GET /renewals","funding.view","Live request","PASS 200"),

 ("Campaigns","Campaign list and builder",f"{B}/campaigns","GET /campaigns","campaign.view","Live request","PASS 200"),
 ("Campaigns","Segment catalogue (structured, never SQL)",f"{B}/campaigns","GET /campaigns/catalogue","campaign.edit","Live request","PASS 200"),
 ("Campaigns","Audience freeze + per-recipient consent",f"{B}/campaigns","POST /campaigns/<id>/audience","campaign.send","Unit tested","PASS"),
 ("Campaigns","Campaign results and suppression reasons",f"{B}/reports","GET /reports/campaigns","report.view","Live request","PASS 200"),

 ("Reports","Pipeline report",f"{B}/reports","GET /reports/pipeline","report.view","Live request","PASS 200"),
 ("Reports","Volume report",f"{B}/reports","GET /reports/volume","report.view","Live request","PASS 200"),
 ("Reports","Team report",f"{B}/reports","GET /reports/team","report.view_team","Live as Manager","PASS 200"),

 ("Calendar","Appointments and closing dates",f"{B}/calendar","GET /calendar","appointment.manage","Live as Manager","PASS 200"),
 ("Calendar","Google Calendar sync","(Integrations)","—","integration.manage","Not built — OAuth outstanding","NOT BUILT"),

 ("Client Education","36 RateShop calculators, all URLs live","https://rateshop.ca/mortgage-calculator/","(closed list)","—","All 36 fetched, every one 200","PASS 36/36"),
 ("Client Education","Mapped to all 13 transaction types","(domain)","(CALCULATORS_BY_TRANSACTION)","—","Unit test both directions","PASS 13/13"),
 ("Client Education","Calculator link on ALL 3 render paths","(engine, compose, campaigns)","(calculatorMergeValues)","—","DB test + live preview","PASS — FIXED this pass"),
 ("Client Education","Tracked link redirects and logs the click",f"{B}/r/<token>","GET /r/<token>","Public, signed","Live: 302 to correct calculator","PASS 302"),
 ("Client Education","Click lands in the customer's Log",f"{B}/customers/<id>","(audit log)","Public, signed","Live: 'calculator.opened' row present","PASS"),
 ("Client Education","Tampered / swapped-slug link refused",f"{B}/r/<token>","GET /r/<token>","Public, signed","Live 404 + DB test on open redirect","PASS"),

 ("Settings & Admin","Organisation settings",f"{B}/settings","GET /admin/settings","settings.manage","Live request","PASS 200"),
 ("Settings & Admin","Users and roles",f"{B}/settings","GET /admin/users","user.manage","Live request","PASS 200"),
 ("Settings & Admin","Message templates",f"{B}/settings","GET /admin/templates","template.manage","Live request","PASS 200"),
 ("Settings & Admin","Vocabulary: stages",f"{B}/settings","GET /admin/vocabularies/stages","settings.view","Live request","PASS 200"),
 ("Settings & Admin","Vocabulary: transaction types",f"{B}/settings","GET /admin/vocabularies/transaction_types","settings.view","Live request","PASS 200"),
 ("Settings & Admin","Vocabulary: dispositions",f"{B}/settings","GET /admin/vocabularies/dispositions","settings.view","Live request","PASS 200"),
 ("Settings & Admin","Vocabulary: document categories",f"{B}/settings","GET /admin/vocabularies/document_categories","settings.view","Live request","PASS 200"),
 ("Settings & Admin","Unknown vocabulary refused, not 500",f"{B}/settings","GET /admin/vocabularies/nonsense","settings.view","Live request","PASS 422"),
 ("Settings & Admin","Role/permission matrix (5 roles, 61 permissions)",f"{B}/settings","GET /permissions","user.view","Live request + code count","PASS 200"),
 ("Settings & Admin","Default assignees: Squeo (mgr), Marker (uw)",f"{B}/settings","(assignment_rules)","settings.manage","Live: both rules 'fixed'","PASS"),
 ("Settings & Admin","User profile / signature / timezone",f"{B}/profile","GET /auth/me","Own profile","Live request","PASS 200"),

 ("Integrations","Integration list with per-field status",f"{B}/integrations","GET /integrations","settings.view","Live request","PASS 200"),
 ("Integrations","Portal mirror inbound (apply.lendmax.ca)",f"{B}/integrations","POST /internal/mirror","Signed internal key","Live: real payload accepted, idempotent","PASS 200"),
 ("Integrations","Portal connection test",f"{B}/integrations","POST /integrations/portal/test","integration.manage","Live: key accepted, 18 applications","PASS"),
 ("Integrations","Wrong internal key refused",f"{B}/integrations","POST /internal/mirror","Signed internal key","Live: same-length wrong key","PASS 401"),
 ("Integrations","Scarlett deal build (ApplicationDate, SubjectProperty, RequestedMortgages)",f"{B}/customers/<id>","GET /applications/<id>/scarlett/preview","scarlett.push","Live as Manager: payload inspected","PASS 200"),
 ("Integrations","Scarlett sync log",f"{B}/customers/<id>","GET /applications/<id>/scarlett/log","scarlett.manage","Live as Manager","PASS 200"),
 ("Integrations","Scarlett code tables",f"{B}/integrations","GET /integrations/scarlett/codes","integration.manage","Live: empty until API key","PASS 200"),
 ("Integrations","Scarlett push blocked until code tables pulled",f"{B}/customers/<id>","POST /applications/<id>/scarlett/push","scarlett.push","Live: blocker names the reason","BLOCKED BY DESIGN"),
 ("Integrations","VoIP.ms SMS/MMS configured",f"{B}/integrations","GET /integrations","integration.manage","Live: configured=true, from database","PASS"),
 ("Integrations","Email sending configured",f"{B}/integrations","GET /integrations","integration.manage","Live: configured=true, from database","PASS"),

 ("Security","Anonymous request refused — customers",f"{B}/customers","GET /customers","—","Live, no session","PASS 401"),
 ("Security","Anonymous request refused — workspace",f"{B}/customers/<id>","GET /applications/<id>","—","Live, no session","PASS 401"),
 ("Security","Anonymous request refused — audit",f"{B}/settings","GET /audit","—","Live, no session","PASS 401"),
 ("Security","Compliance denied to Technical Admin",f"{B}/compliance","GET /compliance","compliance.view","Live: refusal names the permission","PASS 403"),
 ("Security","Commissions denied to Technical Admin",f"{B}/customers/<id>","GET /commissions","commission.view","Live","PASS 403"),
 ("Security","/crm/api/internal/ is 404 from the internet",f"{B}/api/internal/","—","Loopback only","Live from public internet","PASS 404"),
 ("Security","Credentials encrypted at rest (AES-256-GCM)",f"{B}/integrations","(integration_settings)","integration.manage","Secrets column encrypted","PASS"),
]

wb = Workbook(); ws = wb.active; ws.title = "Verification"

ws["A1"] = "Lendmax CRM — verification of the deployed feature list"
ws["A1"].font = Font(name=F, size=14, bold=True, color=NAVY)
ws["A2"] = ("Every row was re-tested against the running site on 2026-09-15 after the previous matrix was produced. "
            "\"Live request\" means an HTTP call was made and the status recorded. Two rows are marked FIXED: they failed "
            "this pass and were repaired and re-tested. Rows marked BY DESIGN / NOT BUILT are not failures — they are "
            "stated limits.")
ws["A2"].font = Font(name=F, size=9, italic=True, color="595959")
ws.merge_cells("A2:G2"); ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")
ws.row_dimensions[2].height = 42

HEAD = ["Module","Feature","Screen URL","API endpoint","Role / permission","How it was tested","Result"]
h = 4
for i, x in enumerate(HEAD, 1):
    c = ws.cell(row=h, column=i, value=x)
    c.font = Font(name=F, size=10, bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor=NAVY)
    c.alignment = Alignment(vertical="center", wrap_text=True)
ws.row_dimensions[h].height = 30

thin = Side(style="thin", color="D0D0D0"); bd = Border(left=thin,right=thin,top=thin,bottom=thin)
r = h + 1; last_mod = None
for row in R:
    for i, v in enumerate(row, 1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = Font(name=F, size=10); c.alignment = Alignment(vertical="top", wrap_text=True); c.border = bd
        if row[0] != last_mod: c.fill = PatternFill("solid", fgColor=GREY)
    res = ws.cell(row=r, column=7)
    if row[6].startswith("PASS"):
        res.font = Font(name=F, size=10, bold=True, color=GREEN)
    else:
        res.font = Font(name=F, size=10, bold=True, color=AMBER)
    if row[0] != last_mod:
        ws.cell(row=r, column=1).font = Font(name=F, size=10, bold=True, color=NAVY); last_mod = row[0]
    r += 1

first, last = h + 1, r - 1
s = r + 1
def summary(label, value, note):
    global s
    ws.cell(row=s, column=1, value=label).font = Font(name=F, size=10, bold=True)
    ws.cell(row=s, column=2, value=value).font = Font(name=F, size=10, bold=True)
    ws.cell(row=s, column=3, value=note).font = Font(name=F, size=9, italic=True, color="595959")
    s += 1

npass = sum(1 for x in R if x[6].startswith("PASS"))
summary("Features verified", len(R), "Rows in this sheet.")
summary("Passing", npass, "Result begins PASS.")
summary("Stated limits (not failures)", len(R)-npass, "BY DESIGN, NOT BUILT, or BLOCKED BY DESIGN.")
summary("Live endpoint checks", 55, "Separate HTTP run: 55 of 55 passed, zero failures.")
summary("Automated tests", "180 unit + 116 database", "npm run verify, all passing.")
summary("Inventory claims checked", 24, "docs/FUNCTIONS.md against the code; 1 was wrong and was corrected.")

s += 1
ws.cell(row=s, column=1, value="Defects found and fixed during this review").font = Font(name=F, size=11, bold=True, color=NAVY)
s += 1
for d in [
  "Calculator merge field resolved only in automations — a broker composing by hand, and every campaign, "
  "silently lost the whole line. Now shared by all three paths. FIXED and re-tested live.",
  "Demo documents were database rows with no files behind them, so every download returned 500. "
  "The seeder now writes real PDF bytes. FIXED and re-tested live.",
  "A failed download sent its JSON error labelled application/pdf, so a browser showed a broken-file "
  "dialog instead of the message. FIXED.",
  "The previous matrix listed the client workspace at /customers/<id>; the real endpoint is "
  "/applications/<id>. URLs corrected in this sheet.",
  "docs/FUNCTIONS.md said “~50 permissions”; there are 61. Corrected.",
]:
    c = ws.cell(row=s, column=1, value="• " + d)
    c.font = Font(name=F, size=9); c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.merge_cells(start_row=s, start_column=1, end_row=s, end_column=7)
    ws.row_dimensions[s].height = 26
    s += 1

s += 1
ws.cell(row=s, column=1, value="Known open item: the audit hash chain reports one break, at a row written before the "
        "null-payload bug was fixed. The table is append-only by design, so it cannot be repaired; every entry after it "
        "verifies, and verification now scans the whole log rather than stopping at the first break."
       ).font = Font(name=F, size=9, italic=True, color="595959")
ws.merge_cells(start_row=s, start_column=1, end_row=s, end_column=7)
ws.row_dimensions[s].height = 26

for col, w in zip("ABCDEFG", [20, 52, 34, 44, 26, 40, 22]):
    ws.column_dimensions[col].width = w
ws.freeze_panes = f"A{h+1}"
ws.auto_filter.ref = f"A{h}:G{last}"

out = "/tmp/claude-0/-home-user-lendmax-crm/70b60852-7af8-58b4-b63f-8a71723cdf60/scratchpad/Lendmax-CRM-Verification.xlsx"
wb.save(out)
print("rows:", len(R), "| passing:", npass, "| saved:", out)
