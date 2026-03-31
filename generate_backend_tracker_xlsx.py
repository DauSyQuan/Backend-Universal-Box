from __future__ import annotations

import csv
import datetime as dt
import re
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


BASE = Path(r"C:\Users\OSB\OneDrive - OSB Holding JSC\Documents\Playground")
WEEKLY_CSV = BASE / "backend_weekly_tracker_solo.csv"
PHASE_CSV = BASE / "backend_phase_summary_solo.csv"
OUTPUT_XLSX = BASE / "backend_tracker_solo_professional.xlsx"
FALLBACK_OUTPUT_XLSX = BASE / "backend_tracker_solo_professional_v2.xlsx"


def col_letter(idx: int) -> str:
    result = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        result = chr(65 + rem) + result
    return result


def xml_inline_string(value: str) -> str:
    safe = escape(value)
    safe = safe.replace("\n", "&#10;")
    return f'<c t="inlineStr"><is><t xml:space="preserve">{safe}</t></is></c>'


def xml_number(value: str) -> str:
    return f"<c><v>{value}</v></c>"


def excel_serial(date_text: str) -> int:
    date_obj = dt.datetime.strptime(date_text, "%Y-%m-%d").date()
    epoch = dt.date(1899, 12, 30)
    return (date_obj - epoch).days


def split_cell_ref(cell_ref: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)(\d+)", cell_ref)
    if not match:
        raise ValueError(f"Invalid cell reference: {cell_ref}")
    letters, row = match.groups()
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - 64)
    return col, int(row)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def build_dimension(rows: int, cols: int) -> str:
    return f"A1:{col_letter(cols)}{rows}"


PHASE_STYLE_MAP = {
    "Phase 0 - Scope & Design": 3,
    "Phase 1 - Infra & Project Setup": 4,
    "Phase 2 - MCU Ingest": 5,
    "Phase 3 - Package & Usage": 6,
    "Phase 4 - Captain Portal & VMS": 7,
    "Phase 5 - Command Flow & RBAC": 8,
    "Phase 6 - Staging & Pilot": 9,
}

STATUS_STYLE_MAP = {
    "Not Started": 10,
    "In Progress": 11,
    "Blocked": 12,
    "Done": 13,
}

RISK_STYLE_MAP = {
    "High": 14,
    "Medium": 15,
    "Low": 16,
}

PRIORITY_STYLE_MAP = {
    "Critical": 17,
    "High": 18,
    "Medium": 19,
    "Low": 20,
}

DONE_STYLE_MAP = {
    "Y": 13,
    "N": 10,
}


def make_cell(ref: str, value: str, style_id: int | None = None, numeric: bool = False) -> str:
    style_attr = f' s="{style_id}"' if style_id is not None else ""
    if numeric:
        return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'
    safe = escape(value)
    safe = safe.replace("\n", "&#10;")
    return f'<c r="{ref}"{style_attr} t="inlineStr"><is><t xml:space="preserve">{safe}</t></is></c>'


def make_date_cell(ref: str, date_text: str, style_id: int = 21) -> str:
    return f'<c r="{ref}" s="{style_id}"><v>{excel_serial(date_text)}</v></c>'


def make_formula_cell(ref: str, formula: str, style_id: int | None = None) -> str:
    style_attr = f' s="{style_id}"' if style_id is not None else ""
    return f'<c r="{ref}"{style_attr}><f>{formula}</f></c>'


def sheet_xml(
    title: str,
    headers: list[str],
    rows: list[list[str]],
    widths: list[int],
    freeze_cell: str,
    autofilter: str,
    row_builder,
) -> str:
    freeze_col, freeze_row = split_cell_ref(freeze_cell)
    x_split = freeze_col - 1
    y_split = freeze_row - 1
    cols_xml = []
    for i, width in enumerate(widths, start=1):
        cols_xml.append(f'<col min="{i}" max="{i}" width="{width}" customWidth="1"/>')
    row_xml = [row_builder(1, headers, is_header=True)]
    for idx, row in enumerate(rows, start=2):
        row_xml.append(row_builder(idx, row, is_header=False))
    dim = build_dimension(len(rows) + 1, len(headers))
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="{dim}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane xSplit="{x_split}" ySplit="{y_split}" topLeftCell="{freeze_cell}" activePane="bottomRight" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>{''.join(cols_xml)}</cols>
  <sheetData>
    {''.join(row_xml)}
  </sheetData>
  <autoFilter ref="{autofilter}"/>
  <pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>'''


def tracker_row_builder(row_idx: int, values: list[str], is_header: bool) -> str:
    cells = []
    if is_header:
        for col_idx, value in enumerate(values, start=1):
            ref = f"{col_letter(col_idx)}{row_idx}"
            cells.append(make_cell(ref, value, style_id=1))
        return f'<row r="{row_idx}" ht="26" customHeight="1">{"".join(cells)}</row>'

    phase = values[3]
    phase_style = PHASE_STYLE_MAP.get(phase, 2)
    for col_idx, value in enumerate(values, start=1):
        ref = f"{col_letter(col_idx)}{row_idx}"
        style_id = 2
        if col_idx == 2 or col_idx == 3:
            cells.append(make_date_cell(ref, value))
            continue
        if col_idx == 4:
            style_id = phase_style
        elif col_idx == 9:
            style_id = STATUS_STYLE_MAP.get(value, 2)
        elif col_idx == 10:
            cells.append(make_cell(ref, value, style_id=22, numeric=True))
            continue
        elif col_idx == 11:
            style_id = RISK_STYLE_MAP.get(value, 2)
        elif col_idx == 12:
            style_id = PRIORITY_STYLE_MAP.get(value, 2)
        elif col_idx == 14:
            style_id = DONE_STYLE_MAP.get(value, 2)
        cells.append(make_cell(ref, value, style_id=style_id))
    return f'<row r="{row_idx}" ht="42" customHeight="1">{"".join(cells)}</row>'


def phase_row_builder(row_idx: int, values: list[str], is_header: bool) -> str:
    cells = []
    if is_header:
        for col_idx, value in enumerate(values, start=1):
            ref = f"{col_letter(col_idx)}{row_idx}"
            cells.append(make_cell(ref, value, style_id=1))
        return f'<row r="{row_idx}" ht="26" customHeight="1">{"".join(cells)}</row>'

    phase = values[0]
    phase_style = PHASE_STYLE_MAP.get(phase, 2)
    for col_idx, value in enumerate(values, start=1):
        ref = f"{col_letter(col_idx)}{row_idx}"
        style_id = 2
        if col_idx in (2, 3):
            cells.append(make_date_cell(ref, value))
            continue
        if col_idx == 1:
            style_id = phase_style
        elif col_idx == 4:
            cells.append(make_cell(ref, value, style_id=22, numeric=True))
            continue
        elif col_idx == 8:
            style_id = PRIORITY_STYLE_MAP.get(value, 2)
        cells.append(make_cell(ref, value, style_id=style_id))
    return f'<row r="{row_idx}" ht="38" customHeight="1">{"".join(cells)}</row>'


def overview_xml() -> str:
    rows = []
    rows.append('<row r="1" ht="30" customHeight="1">' + make_cell("A1", "Backend Solo Roadmap Dashboard", 23) + "</row>")
    rows.append('<row r="2" ht="18" customHeight="1">' + make_cell("A2", "Project timeline and self-management tracker for backend implementation", 24) + "</row>")
    rows.append(
        '<row r="4" ht="24" customHeight="1">'
        + make_cell("A4", "Metric", 1)
        + make_cell("B4", "Value", 1)
        + "</row>"
    )
    rows.append('<row r="5">' + make_cell("A5", "Project Start", 2) + make_date_cell("B5", "2026-04-01") + "</row>")
    rows.append('<row r="6">' + make_cell("A6", "Planned Finish", 2) + make_date_cell("B6", "2026-08-11") + "</row>")
    rows.append('<row r="7">' + make_cell("A7", "Total Weeks", 2) + make_cell("B7", "19", 22, numeric=True) + "</row>")
    rows.append('<row r="8">' + make_cell("A8", "Owner", 2) + make_cell("B8", "Me", 2) + "</row>")
    rows.append('<row r="10" ht="24" customHeight="1">' + make_cell("A10", "Legend", 1) + make_cell("B10", "Meaning", 1) + "</row>")
    legend = [
        ("A11", "Phase Colors", 3, "B11", "Each phase uses a distinct color band for fast scanning"),
        ("A12", "Status", 11, "B12", "Track actual execution status"),
        ("A13", "Risk", 14, "B13", "Use this to highlight blockers early"),
        ("A14", "Priority", 17, "B14", "Critical items should be protected first"),
    ]
    for left_ref, left_val, style_id, right_ref, right_val in legend:
        rows.append(f'<row r="{re.sub(r"[^0-9]", "", left_ref)}">' + make_cell(left_ref, left_val, style_id) + make_cell(right_ref, right_val, 2) + "</row>")
    rows.append('<row r="16" ht="24" customHeight="1">' + make_cell("A16", "How To Use", 1) + "</row>")
    tips = [
        "Update Status, Progress (%) and Done (Y/N) every Friday.",
        "Only move to the next phase when the exit criteria are truly met.",
        "If a week slips, record the reason in Notes instead of hiding it.",
        "Keep MVP discipline: do not expand scope unless it removes a blocker.",
    ]
    for i, tip in enumerate(tips, start=17):
        rows.append(f'<row r="{i}" ht="30" customHeight="1">' + make_cell(f"A{i}", tip, 2) + "</row>")

    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:B20"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>
    <col min="1" max="1" width="28" customWidth="1"/>
    <col min="2" max="2" width="54" customWidth="1"/>
  </cols>
  <sheetData>
    {''.join(rows)}
  </sheetData>
  <pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>'''


def workbook_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews>
    <workbookView activeTab="1"/>
  </bookViews>
  <sheets>
    <sheet name="Overview" sheetId="1" r:id="rId1"/>
    <sheet name="Weekly Tracker" sheetId="2" r:id="rId2"/>
    <sheet name="Phase Summary" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>'''


def workbook_rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def root_rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''


def content_types_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''


def styles_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF1F2937"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="16"/><color rgb="FF0F172A"/><name val="Aptos Display"/><family val="2"/></font>
    <font><i/><sz val="10"/><color rgb="FF475569"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="17">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F4C81"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD6EAF8"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD5F5E3"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFDEBD0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFADBD8"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8DAEF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD4E6F1"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFECACA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border>
      <left/><right/><top/><bottom/><diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FFD1D5DB"/></left>
      <right style="thin"><color rgb="FFD1D5DB"/></right>
      <top style="thin"><color rgb="FFD1D5DB"/></top>
      <bottom style="thin"><color rgb="FFD1D5DB"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="25">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="9" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="11" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="12" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="16" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="14" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="15" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="16" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="14" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="15" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="11" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="14" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="1" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>'''


def core_xml() -> str:
    now = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
  <dc:title>Backend Solo Tracker</dc:title>
</cp:coreProperties>'''


def app_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Excel</Application>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>3</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="3" baseType="lpstr">
      <vt:lpstr>Overview</vt:lpstr>
      <vt:lpstr>Weekly Tracker</vt:lpstr>
      <vt:lpstr>Phase Summary</vt:lpstr>
    </vt:vector>
  </TitlesOfParts>
</Properties>'''


def create_workbook(output_path: Path = OUTPUT_XLSX) -> None:
    weekly_rows = read_csv(WEEKLY_CSV)
    phase_rows = read_csv(PHASE_CSV)

    weekly_headers = list(weekly_rows[0].keys())
    weekly_values = [list(row.values()) for row in weekly_rows]
    weekly_widths = [11, 12, 12, 28, 28, 58, 28, 12, 14, 12, 12, 12, 10, 10, 34]
    weekly_sheet = sheet_xml(
        "Weekly Tracker",
        weekly_headers,
        weekly_values,
        weekly_widths,
        freeze_cell="D2",
        autofilter=f"A1:{col_letter(len(weekly_headers))}{len(weekly_values) + 1}",
        row_builder=tracker_row_builder,
    )

    phase_headers = list(phase_rows[0].keys())
    phase_values = [list(row.values()) for row in phase_rows]
    phase_widths = [28, 12, 12, 14, 28, 45, 45, 12, 24]
    phase_sheet = sheet_xml(
        "Phase Summary",
        phase_headers,
        phase_values,
        phase_widths,
        freeze_cell="B2",
        autofilter=f"A1:{col_letter(len(phase_headers))}{len(phase_values) + 1}",
        row_builder=phase_row_builder,
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml())
        zf.writestr("_rels/.rels", root_rels_xml())
        zf.writestr("docProps/core.xml", core_xml())
        zf.writestr("docProps/app.xml", app_xml())
        zf.writestr("xl/workbook.xml", workbook_xml())
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml())
        zf.writestr("xl/styles.xml", styles_xml())
        zf.writestr("xl/worksheets/sheet1.xml", overview_xml())
        zf.writestr("xl/worksheets/sheet2.xml", weekly_sheet)
        zf.writestr("xl/worksheets/sheet3.xml", phase_sheet)


if __name__ == "__main__":
    try:
        create_workbook(OUTPUT_XLSX)
        print(OUTPUT_XLSX)
    except PermissionError:
        create_workbook(FALLBACK_OUTPUT_XLSX)
        print(FALLBACK_OUTPUT_XLSX)
