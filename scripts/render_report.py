"""Render the project report. Requires reportlab; does not modify the application."""
from pathlib import Path
import re
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/Ishtirak_Project_Report.pdf'
font = 'Helvetica'
if Path('C:/Windows/Fonts/arial.ttf').exists():
    pdfmetrics.registerFont(TTFont('ReportSans', 'C:/Windows/Fonts/arial.ttf'))
    pdfmetrics.registerFont(TTFont('ReportSans-Bold', 'C:/Windows/Fonts/arialbd.ttf'))
    pdfmetrics.registerFontFamily('ReportSans', normal='ReportSans', bold='ReportSans-Bold', italic='ReportSans', boldItalic='ReportSans-Bold')
    font = 'ReportSans'
bold = font + '-Bold'
green = colors.HexColor('#234b36')
muted = colors.HexColor('#56615a')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='ReportBody', fontName=font, fontSize=10.5, leading=15, spaceAfter=9, textColor=colors.HexColor('#1e2922')))
styles.add(ParagraphStyle(name='ReportH2', fontName=bold, fontSize=19, leading=24, spaceBefore=19, spaceAfter=12, textColor=green, keepWithNext=True))
styles.add(ParagraphStyle(name='ReportH3', fontName=bold, fontSize=13, leading=18, spaceBefore=14, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle(name='ReportCell', fontName=font, fontSize=8.7, leading=12, spaceAfter=0))
styles.add(ParagraphStyle(name='ReportHeadCell', fontName=bold, fontSize=9, leading=12, textColor=colors.white))
styles.add(ParagraphStyle(name='ReportTitle', fontName=bold, fontSize=44, leading=49, textColor=green, spaceAfter=18))
styles.add(ParagraphStyle(name='ReportSubtitle', fontName=font, fontSize=23, leading=30, spaceAfter=20))

def inline(value):
    value = escape(value)
    value = re.sub(r'`([^`]+)`', r'<font color="#234b36">\1</font>', value)
    return re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', value)

def para(value, style='ReportBody'):
    return Paragraph(inline(value), styles[style])

width = A4[0] - 96
story = [Spacer(1, 48), para('ISHTIRAK', 'ReportTitle'),
         para('Distributed Neighborhood<br/>Capacity Coordination'.replace('<br/>', '\n'), 'ReportSubtitle'),
         para('Final project report | Distributed Systems | 29 October 2026'), Spacer(1, 25),
         para('A finite generator budget, coordinated through a majority-committed ledger.', 'ReportH2'),
         para('Three Go coordinators agree on capacity grants. Building gateways aggregate MQTT readings and enforce short-lived budgets in a simulated served-load calculation. PostgreSQL preserves audit and telemetry, and a React dashboard exposes normal operation and controlled failures.'),
         Spacer(1, 20),
         para('120 A capacity. Three coordinators. Eleven integration phases passed.', 'ReportH3'),
         para('The measured run admitted 17 of 40 competing 7 A requests, reserving 119 A. No capacity violations were observed in 708 coordinator samples, nor in a randomized fault check of 1,529 requests. The report distinguishes this evidence from a formal proof and explains the timing assumptions and prototype limits.'),
         Spacer(1, 30), para('Application: http://localhost:8088'),
         para('Source, reproduction steps, raw measurements, and an editable PowerPoint accompany this report.'), PageBreak()]

lines = (ROOT / 'docs/PROJECT_REPORT.md').read_text(encoding='utf-8').splitlines()
index = 0
while index < len(lines):
    value = lines[index].strip()
    if not value or value.startswith('# ') or value.startswith('Final project report |'):
        index += 1
        continue
    if value.startswith('## '):
        if value.startswith('## 10.'):
            story.append(PageBreak())
        story.append(para(value[3:], 'ReportH2'))
    elif value.startswith('### '):
        story.append(para(value[4:], 'ReportH3'))
    elif value.startswith('|'):
        rows = []
        while index < len(lines) and lines[index].strip().startswith('|'):
            cells = [cell.strip() for cell in lines[index].strip().strip('|').split('|')]
            if not all(re.fullmatch(r'[:\- ]+', c) for c in cells):
                rows.append(cells)
            index += 1
        count = len(rows[0])
        widths = {2:[width*.30,width*.70],3:[width*.23,width*.35,width*.42],6:[width*.15,width*.14,width*.15,width*.15,width*.17,width*.24]}.get(count, [width/count]*count)
        table = Table([[para(c, 'ReportHeadCell' if r == 0 else 'ReportCell') for c in cells] for r,cells in enumerate(rows)], colWidths=widths, repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),green),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor('#f1f4ef'),colors.white]),('LINEBELOW',(0,1),(-1,-1),.4,colors.HexColor('#d8dfd8'))]))
        story.extend([KeepTogether([table]) if len(rows) <= 8 else table, Spacer(1, 12)])
        continue
    else:
        if value.startswith('- '):
            value = '\u2022 ' + value[2:]
        story.append(para(value))
    index += 1

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#d8dfd8'))
    canvas.line(48, 44, A4[0]-48, 44)
    canvas.setFillColor(muted)
    canvas.setFont(font, 8)
    canvas.drawString(48, 30, 'ISHTIRAK  /  DISTRIBUTED SYSTEMS PROTOTYPE')
    canvas.drawRightString(A4[0]-48, 30, str(doc.page))
    canvas.restoreState()

SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=48, rightMargin=48, topMargin=40, bottomMargin=60,
                  title='Ishtirak - Distributed Neighborhood Capacity Coordination', author='Ishtirak project').build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
