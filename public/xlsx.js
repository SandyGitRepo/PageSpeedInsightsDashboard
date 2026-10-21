// Minimal .xlsx writer: cells, fixed styles, hyperlinks, conditional formats and native Excel charts.
// No dependencies; the workbook is zipped in the browser (CompressionStream, else stored).

const NS = {
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  pkgRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
};
const REL_TYPE = (name) => `${NS.rel}/${name}`;
const CT = 'application/vnd.openxmlformats-officedocument';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NAVY = '002953';
const BLUE = '005EAC';
const MUTED = '5F6B7A';
const TEXT_2 = '3F4A5A';
const BORDER = 'D5DCEB';
const TILE = 'F2F5FB';

// ---------- styles ----------

const FONTS = [
  '<font><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/><family val="2"/></font>',
  `<font><b/><sz val="20"/><color rgb="FF${NAVY}"/><name val="Calibri"/><family val="2"/></font>`,
  `<font><sz val="10"/><color rgb="FF${MUTED}"/><name val="Calibri"/><family val="2"/></font>`,
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',
  '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font>',
  `<font><b/><sz val="13"/><color rgb="FF${NAVY}"/><name val="Calibri"/><family val="2"/></font>`,
  `<font><b/><sz val="22"/><color rgb="FF${BLUE}"/><name val="Calibri"/><family val="2"/></font>`,
  `<font><b/><sz val="10"/><color rgb="FF${TEXT_2}"/><name val="Calibri"/><family val="2"/></font>`,
  '<font><b/><sz val="22"/><color rgb="FF0A7A32"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="22"/><color rgb="FFA15C00"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="22"/><color rgb="FFC62828"/><name val="Calibri"/><family val="2"/></font>',
  '<font><sz val="11"/><color rgb="FFC62828"/><name val="Calibri"/><family val="2"/></font>',
];
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${NAVY}"/><bgColor indexed="64"/></patternFill></fill>`,
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${TILE}"/><bgColor indexed="64"/></patternFill></fill>`,
];
const side = (name) => `<${name} style="thin"><color rgb="FF${BORDER}"/></${name}>`;
const BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`,
  `<border><left/><right/><top/>${`<bottom style="medium"><color rgb="FF${BLUE}"/></bottom>`}<diagonal/></border>`,
];
const NUM_FMTS = { 164: 'dd-mmm-yyyy hh:mm', 165: '0.000', 166: '0.00%' };

// name → [numFmtId, fontId, fillId, borderId, alignment]
const XF = {
  default: [0, 0, 0, 0],
  title: [0, 1, 0, 0],
  subtitle: [0, 2, 0, 0],
  heading: [0, 5, 0, 2],
  header: [0, 3, 2, 1, '<alignment vertical="center" wrapText="1"/>'],
  text: [0, 0, 0, 1, '<alignment vertical="top"/>'],
  wrap: [0, 0, 0, 1, '<alignment vertical="top" wrapText="1"/>'],
  int: [1, 0, 0, 1, '<alignment horizontal="center" vertical="top"/>'],
  number: [3, 0, 0, 1, '<alignment vertical="top"/>'],
  decimal: [165, 0, 0, 1, '<alignment vertical="top"/>'],
  percent: [166, 0, 0, 1, '<alignment horizontal="center" vertical="top"/>'],
  date: [164, 0, 0, 1, '<alignment horizontal="left" vertical="top"/>'],
  link: [0, 4, 0, 1, '<alignment vertical="top"/>'],
  navLink: [0, 4, 0, 0],
  label: [0, 7, 0, 1, '<alignment vertical="top"/>'],
  error: [0, 11, 0, 1, '<alignment vertical="top" wrapText="1"/>'],
  kpiLabel: [0, 7, 3, 0, '<alignment vertical="bottom" indent="1"/>'],
  kpiValue: [0, 6, 3, 0, '<alignment vertical="center" indent="1"/>'],
  kpiGood: [0, 8, 3, 0, '<alignment vertical="center" indent="1"/>'],
  kpiAvg: [0, 9, 3, 0, '<alignment vertical="center" indent="1"/>'],
  kpiPoor: [0, 10, 3, 0, '<alignment vertical="center" indent="1"/>'],
  kpiNote: [0, 2, 3, 0, '<alignment vertical="top" indent="1" wrapText="1"/>'],
  note: [0, 2, 0, 0, '<alignment vertical="top" wrapText="1"/>'],
};
const XF_INDEX = Object.fromEntries(Object.keys(XF).map((name, i) => [name, i]));

// Conditional-format looks: good / needs improvement / poor (same colors as the dashboard badges).
export const BAND = { good: 0, avg: 1, poor: 2 };
const DXFS = [
  ['0A7A32', 'E7F6EC'],
  ['A15C00', 'FFF3DD'],
  ['C62828', 'FDECEC'],
].map(
  ([font, fill]) =>
    `<dxf><font><b/><color rgb="FF${font}"/></font><fill><patternFill patternType="solid"><bgColor rgb="FF${fill}"/></patternFill></fill></dxf>`,
);

function stylesXml() {
  const numFmts = Object.entries(NUM_FMTS).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`);
  const xfs = Object.values(XF).map(([numFmt, font, fill, border, alignment]) => {
    const applies = `applyNumberFormat="${numFmt ? 1 : 0}" applyFont="1" applyFill="${fill ? 1 : 0}" applyBorder="${border ? 1 : 0}"`;
    const open = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" ${applies}`;
    return alignment ? `${open} applyAlignment="1">${alignment}</xf>` : `${open}/>`;
  });
  return (
    XML_HEAD +
    `<styleSheet xmlns="${NS.main}">` +
    `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` +
    `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>` +
    `<fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
    `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    `<dxfs count="${DXFS.length}">${DXFS.join('')}</dxfs>` +
    '</styleSheet>'
  );
}

// ---------- helpers ----------

function esc(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function colName(col) {
  let name = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// 0-based row/col → "B3"; absolute → "$B$3".
export const cellRef = (row, col, absolute = false) =>
  absolute ? `$${colName(col)}$${row + 1}` : `${colName(col)}${row + 1}`;

const quoteSheet = (name) => `'${name.replace(/'/g, "''")}'`;

export function rangeRef(sheetName, r1, c1, r2 = r1, c2 = c1) {
  const start = cellRef(r1, c1, true);
  const end = cellRef(r2, c2, true);
  return `${quoteSheet(sheetName)}!${start === end ? start : `${start}:${end}`}`;
}

// Excel stores dates as local-time day serials since 1899-12-30.
export function excelDate(ms) {
  return (ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000 + 25569;
}

// ---------- worksheet ----------

class Sheet {
  constructor(name, options) {
    this.name = name;
    this.tabColor = options.tabColor;
    this.rows = new Map();
    this.colWidths = [];
    this.rowHeights = new Map();
    this.merges = [];
    this.links = [];
    this.conditionals = [];
    this.charts = [];
    this.frozen = null;
    this.filter = null;
  }

  // value: string | number | null | { date: ms } | { text, href } | { text, sheet, cell }
  set(row, col, value, style = 'default') {
    if (!this.rows.has(row)) this.rows.set(row, new Map());
    if (value && typeof value === 'object' && 'text' in value) {
      this.links.push({ ref: cellRef(row, col), ...value });
      value = value.text;
    }
    this.rows.get(row).set(col, { value, style });
  }

  row(row, col, values, style) {
    values.forEach((value, i) => this.set(row, col + i, value, Array.isArray(style) ? style[i] : style));
  }

  widths(...widths) {
    this.colWidths = widths;
  }

  height(row, points) {
    this.rowHeights.set(row, points);
  }

  merge(r1, c1, r2, c2) {
    this.merges.push(`${cellRef(r1, c1)}:${cellRef(r2, c2)}`);
  }

  freeze(row, col = 0) {
    this.frozen = { row, col };
  }

  autoFilter(r1, c1, r2, c2) {
    this.filter = `${cellRef(r1, c1)}:${cellRef(r2, c2)}`;
  }

  // rules: [{ formula, band }], formulas are relative to the range's top-left cell.
  conditional(r1, c1, r2, c2, rules) {
    this.conditionals.push({ sqref: `${cellRef(r1, c1)}:${cellRef(r2, c2)}`, rules });
  }

  // anchor: { from: [row, col], to: [row, col] } (0-based, "to" is exclusive).
  chart(spec, anchor) {
    this.charts.push({ spec, anchor });
  }

  cellXml(row, col, { value, style }) {
    const attrs = `r="${cellRef(row, col)}" s="${XF_INDEX[style] ?? 0}"`;
    if (value === null || value === undefined || value === '') return `<c ${attrs}/>`;
    if (typeof value === 'object' && 'date' in value) return `<c ${attrs}><v>${excelDate(value.date)}</v></c>`;
    if (typeof value === 'number') return Number.isFinite(value) ? `<c ${attrs}><v>${value}</v></c>` : `<c ${attrs}/>`;
    return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(String(value).slice(0, 32_767))}</t></is></c>`;
  }

  xml(index, externalLinkIds, drawingRelId) {
    const parts = [XML_HEAD, `<worksheet xmlns="${NS.main}" xmlns:r="${NS.rel}">`];
    parts.push(
      '<sheetPr>',
      this.tabColor ? `<tabColor rgb="FF${this.tabColor}"/>` : '',
      '<pageSetUpPr fitToPage="1"/></sheetPr>',
    );
    const pane = this.frozen
      ? `<pane${this.frozen.col ? ` xSplit="${this.frozen.col}"` : ''} ySplit="${this.frozen.row}" ` +
        `topLeftCell="${cellRef(this.frozen.row, this.frozen.col)}" activePane="bottomLeft" state="frozen"/>`
      : '';
    parts.push(
      `<sheetViews><sheetView showGridLines="0" workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`,
      '<sheetFormatPr defaultRowHeight="15"/>',
    );
    if (this.colWidths.length) {
      parts.push(
        '<cols>',
        ...this.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`),
        '</cols>',
      );
    }
    parts.push('<sheetData>');
    const rowIndexes = [...new Set([...this.rows.keys(), ...this.rowHeights.keys()])].sort((a, b) => a - b);
    for (const r of rowIndexes) {
      const height = this.rowHeights.get(r);
      const cells = [...(this.rows.get(r) ?? new Map())].sort((a, b) => a[0] - b[0]);
      parts.push(
        `<row r="${r + 1}"${height ? ` ht="${height}" customHeight="1"` : ''}>`,
        ...cells.map(([c, cell]) => this.cellXml(r, c, cell)),
        '</row>',
      );
    }
    parts.push('</sheetData>');
    if (this.filter) parts.push(`<autoFilter ref="${this.filter}"/>`);
    if (this.merges.length) {
      parts.push(`<mergeCells count="${this.merges.length}">`, ...this.merges.map((m) => `<mergeCell ref="${m}"/>`), '</mergeCells>');
    }
    let priority = 1;
    for (const { sqref, rules } of this.conditionals) {
      parts.push(`<conditionalFormatting sqref="${sqref}">`);
      for (const { formula, band } of rules) {
        parts.push(
          `<cfRule type="expression" dxfId="${band}" priority="${priority++}" stopIfTrue="1"><formula>${esc(formula)}</formula></cfRule>`,
        );
      }
      parts.push('</conditionalFormatting>');
    }
    if (this.links.length) {
      parts.push('<hyperlinks>');
      for (const link of this.links) {
        if (link.href) {
          parts.push(`<hyperlink ref="${link.ref}" r:id="${externalLinkIds.get(link)}"/>`);
        } else {
          const location = `${quoteSheet(link.sheet)}!${link.cell ?? 'A1'}`;
          parts.push(`<hyperlink ref="${link.ref}" location="${esc(location)}" display="${esc(link.text)}"/>`);
        }
      }
      parts.push('</hyperlinks>');
    }
    parts.push(
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>',
      '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
    );
    if (drawingRelId) parts.push(`<drawing r:id="${drawingRelId}"/>`);
    parts.push('</worksheet>');
    return parts.join('');
  }
}

// ---------- charts ----------

const textProps = (size, bold = false, color = TEXT_2) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}">` +
  `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr>` +
  '<a:endParaRPr lang="en-US"/></a:p></c:txPr>';

const richTitle = (text, size) =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="1"/></a:pPr>` +
  `<a:r><a:rPr lang="en-US" sz="${size}" b="1"><a:solidFill><a:srgbClr val="${NAVY}"/></a:solidFill></a:rPr>` +
  `<a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

const lineProps = (color, width = 9525, dash) =>
  `<a:ln w="${width}" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
  `${dash ? `<a:prstDash val="${dash}"/>` : ''}<a:round/></a:ln>`;

const gridLines = `<c:majorGridlines><c:spPr>${lineProps('E9EEF7')}</c:spPr></c:majorGridlines>`;

function numCache(values, formatCode = 'General') {
  const points = values
    .map((v, i) => (Number.isFinite(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : ''))
    .join('');
  return `<c:numCache><c:formatCode>${esc(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache>`;
}

const numRef = ({ ref, values }, formatCode) => `<c:numRef><c:f>${esc(ref)}</c:f>${numCache(values, formatCode)}</c:numRef>`;

const strPoints = (values) =>
  `<c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}`;

const seriesName = ({ name, nameRef }) =>
  nameRef
    ? `<c:tx><c:strRef><c:f>${esc(nameRef)}</c:f><c:strCache>${strPoints([name])}</c:strCache></c:strRef></c:tx>`
    : `<c:tx><c:v>${esc(name)}</c:v></c:tx>`;

const categories = ({ ref, values }) =>
  ref
    ? `<c:cat><c:strRef><c:f>${esc(ref)}</c:f><c:strCache>${strPoints(values)}</c:strCache></c:strRef></c:cat>`
    : `<c:cat><c:strLit>${strPoints(values)}</c:strLit></c:cat>`;

function scaling({ min, max, reverse } = {}) {
  return (
    `<c:scaling><c:orientation val="${reverse ? 'maxMin' : 'minMax'}"/>` +
    `${Number.isFinite(max) ? `<c:max val="${max}"/>` : ''}${Number.isFinite(min) ? `<c:min val="${min}"/>` : ''}</c:scaling>`
  );
}

function axisTitle(text) {
  if (!text) return '';
  return (
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" b="0"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="900" b="0"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
  );
}

function valueAxis(id, crossId, position, axis = {}, { grid = true, crosses = 'autoZero', crossBetween = 'between' } = {}) {
  return (
    `<c:valAx><c:axId val="${id}"/>${scaling(axis)}<c:delete val="0"/><c:axPos val="${position}"/>` +
    `${grid ? gridLines : ''}${axisTitle(axis.title)}` +
    `<c:numFmt formatCode="${esc(axis.format ?? 'General')}" sourceLinked="0"/>` +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${textProps(900)}` +
    `<c:crossAx val="${crossId}"/><c:crosses val="${crosses}"/><c:crossBetween val="${crossBetween}"/>` +
    `${Number.isFinite(axis.majorUnit) ? `<c:majorUnit val="${axis.majorUnit}"/>` : ''}</c:valAx>`
  );
}

function categoryAxis(id, crossId, position, axis = {}) {
  return (
    `<c:catAx><c:axId val="${id}"/>${scaling(axis)}<c:delete val="0"/><c:axPos val="${position}"/>` +
    `${axisTitle(axis.title)}<c:numFmt formatCode="General" sourceLinked="0"/>` +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:spPr>${lineProps('C9D3E6')}</c:spPr>${textProps(900)}` +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>` +
    '<c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
  );
}

// spec.type: 'scatter' (time series) | 'bar' (horizontal) | 'column'
function chartXml(spec) {
  let plot;
  if (spec.type === 'scatter') {
    const series = spec.series.map(
      (s, i) =>
        `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s)}` +
        `<c:spPr>${lineProps(s.color, 22225, s.dash)}</c:spPr>` +
        (s.markers
          ? `<c:marker><c:symbol val="circle"/><c:size val="4"/><c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`
          : '<c:marker><c:symbol val="none"/></c:marker>') +
        `<c:xVal>${numRef(s.x, spec.xAxis?.format)}</c:xVal><c:yVal>${numRef(s.y)}</c:yVal><c:smooth val="0"/></c:ser>`,
    );
    plot =
      `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series.join('')}` +
      '<c:axId val="1001"/><c:axId val="1002"/></c:scatterChart>' +
      valueAxis(1001, 1002, 'b', spec.xAxis, { grid: false, crossBetween: 'midCat' }) +
      valueAxis(1002, 1001, 'l', spec.yAxis, { crossBetween: 'midCat' });
  } else {
    const horizontal = spec.type === 'bar';
    const series = spec.series.map(
      (s, i) =>
        `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s)}` +
        `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>` +
        `<c:invertIfNegative val="0"/>${categories(spec.categories)}<c:val>${numRef(s)}</c:val></c:ser>`,
    );
    plot =
      `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${spec.stacked ? 'stacked' : 'clustered'}"/>` +
      `<c:varyColors val="0"/>${series.join('')}<c:gapWidth val="${spec.stacked ? 60 : 80}"/>` +
      `<c:overlap val="${spec.stacked ? 100 : -10}"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>` +
      // Horizontal bars list categories top-down, so the value axis sits at the far ("max") end.
      categoryAxis(1001, 1002, horizontal ? 'l' : 'b', { reverse: horizontal }) +
      valueAxis(1002, 1001, horizontal ? 'b' : 'l', spec.valueAxis, { crosses: horizontal ? 'max' : 'autoZero' });
  }
  return (
    XML_HEAD +
    `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.rel}">` +
    '<c:roundedCorners val="0"/>' +
    `<c:chart>${richTitle(spec.title, 1300)}<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${textProps(900)}</c:legend>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>${lineProps(BORDER)}</c:spPr>` +
    `${textProps(1000)}</c:chartSpace>`
  );
}

function drawingXml(charts, firstChartRel) {
  const anchors = charts.map(({ anchor }, i) => {
    const marker = (tag, [row, col]) =>
      `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
    return (
      `<xdr:twoCellAnchor editAs="oneCell">${marker('from', anchor.from)}${marker('to', anchor.to)}` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/>` +
      '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${NS.c}"><c:chart r:id="rId${firstChartRel + i}"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>'
    );
  });
  return (
    XML_HEAD +
    `<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.rel}" xmlns:c="${NS.c}">${anchors.join('')}</xdr:wsDr>`
  );
}

function relsXml(rels) {
  const items = rels.map(
    ({ id, type, target, external }) =>
      `<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`,
  );
  return `${XML_HEAD}<Relationships xmlns="${NS.pkgRel}">${items.join('')}</Relationships>`;
}

// ---------- workbook ----------

export class Workbook {
  constructor({ title = '', creator = '' } = {}) {
    this.title = title;
    this.creator = creator;
    this.sheets = [];
  }

  addSheet(name, options = {}) {
    const sheet = new Sheet(name, options);
    this.sheets.push(sheet);
    return sheet;
  }

  files() {
    const files = {};
    const overrides = [
      ['/xl/workbook.xml', `${CT}.spreadsheetml.sheet.main+xml`],
      ['/xl/styles.xml', `${CT}.spreadsheetml.styles+xml`],
      ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ];
    let chartCount = 0;
    let drawingCount = 0;

    this.sheets.forEach((sheet, i) => {
      const n = i + 1;
      const rels = [];
      const externalLinkIds = new Map();
      for (const link of sheet.links.filter((l) => l.href)) {
        const id = `rId${rels.length + 1}`;
        externalLinkIds.set(link, id);
        rels.push({ id, type: REL_TYPE('hyperlink'), target: link.href, external: true });
      }
      let drawingRelId = null;
      if (sheet.charts.length) {
        const d = ++drawingCount;
        drawingRelId = `rId${rels.length + 1}`;
        rels.push({ id: drawingRelId, type: REL_TYPE('drawing'), target: `../drawings/drawing${d}.xml` });
        const chartRels = sheet.charts.map(({ spec }, k) => {
          const c = ++chartCount;
          files[`xl/charts/chart${c}.xml`] = chartXml(spec);
          overrides.push([`/xl/charts/chart${c}.xml`, `${CT}.drawingml.chart+xml`]);
          return { id: `rId${k + 1}`, type: REL_TYPE('chart'), target: `../charts/chart${c}.xml` };
        });
        files[`xl/drawings/drawing${d}.xml`] = drawingXml(sheet.charts, 1);
        files[`xl/drawings/_rels/drawing${d}.xml.rels`] = relsXml(chartRels);
        overrides.push([`/xl/drawings/drawing${d}.xml`, `${CT}.drawing+xml`]);
      }
      files[`xl/worksheets/sheet${n}.xml`] = sheet.xml(i, externalLinkIds, drawingRelId);
      if (rels.length) files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = relsXml(rels);
      overrides.push([`/xl/worksheets/sheet${n}.xml`, `${CT}.spreadsheetml.worksheet+xml`]);
    });

    const sheetsXml = this.sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('');
    const filterNames = this.sheets
      .map((s, i) =>
        s.filter
          ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`${quoteSheet(s.name)}!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`)}</definedName>`
          : '',
      )
      .join('');
    files['xl/workbook.xml'] =
      XML_HEAD +
      `<workbook xmlns="${NS.main}" xmlns:r="${NS.rel}"><bookViews><workbookView activeTab="0"/></bookViews>` +
      `<sheets>${sheetsXml}</sheets>${filterNames ? `<definedNames>${filterNames}</definedNames>` : ''}</workbook>`;
    files['xl/_rels/workbook.xml.rels'] = relsXml([
      ...this.sheets.map((_, i) => ({ id: `rId${i + 1}`, type: REL_TYPE('worksheet'), target: `worksheets/sheet${i + 1}.xml` })),
      { id: `rId${this.sheets.length + 1}`, type: REL_TYPE('styles'), target: 'styles.xml' },
    ]);
    files['xl/styles.xml'] = stylesXml();

    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files['docProps/core.xml'] =
      XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(this.title)}</dc:title><dc:creator>${esc(this.creator)}</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
    files['_rels/.rels'] = relsXml([
      { id: 'rId1', type: REL_TYPE('officeDocument'), target: 'xl/workbook.xml' },
      { id: 'rId2', type: `${NS.pkgRel}/metadata/core-properties`, target: 'docProps/core.xml' },
    ]);
    files['[Content_Types].xml'] =
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
      '</Types>';
    return files;
  }

  async toBlob() {
    const encoder = new TextEncoder();
    // [Content_Types].xml first, as Office writes it.
    const entries = Object.entries(this.files())
      .sort(([a], [b]) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0))
      .map(([name, text]) => ({ name, data: encoder.encode(text) }));
    return new Blob([await zip(entries)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }
}

// ---------- zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const compressed = await deflate(data);
    const body = compressed ?? data;
    const crc = crc32(data);
    const header = (size) => {
      const view = new DataView(new ArrayBuffer(size));
      return [view, new Uint8Array(view.buffer)];
    };

    const [local, localBytes] = header(30);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, compressed ? 8 : 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(localBytes, nameBytes, body);

    const [dir, dirBytes] = header(46);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, compressed ? 8 : 0, true);
    dir.setUint16(12, dosTime, true);
    dir.setUint16(14, dosDate, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(dirBytes, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)]);
}
