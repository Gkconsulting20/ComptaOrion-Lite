const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

const normalizeHeader = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim()
  .replace(/[^a-z0-9]+/g, ' ');

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((delimiter) => {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"') {
        if (quoted && firstLine[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && firstLine[index] === delimiter) count += 1;
    }
    return { delimiter, count };
  }).sort((a, b) => b.count - a.count);
  if (!counts[0].count || counts[0].count === counts[1].count) return null;
  return counts[0].delimiter;
}

export function parseCsvDocument(text) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BYTES) throw new Error('Le fichier dépasse 2 Mo. Exportez une période plus courte.');
  const delimiter = detectDelimiter(text);
  if (!delimiter) throw new Error('Séparateur ambigu. Vérifiez que le fichier comporte des colonnes séparées par virgules, points-virgules ou tabulations.');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(cell); cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error('Le fichier contient un guillemet qui n’est pas refermé.');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('Aucune ligne de relevé trouvée sous les en-têtes.');
  const headers = rows.shift().map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
  const dataRows = rows.filter((entry) => entry.some((value) => value.trim()));
  if (dataRows.length > MAX_ROWS) throw new Error('Le relevé dépasse la limite de 5 000 lignes. Importez une période plus courte.');
  const width = Math.max(...dataRows.map((entry) => entry.length));
  if (headers.length !== width) throw new Error('Les lignes ne possèdent pas toutes le même nombre de colonnes que les en-têtes.');
  return { headers, rows: dataRows, delimiter };
}

export function suggestCsvMapping(headers) {
  const patterns = {
    date: ['date', 'date operation', 'date valeur', 'transaction date'],
    description: ['description', 'libelle', 'motif', 'operation', 'detail', 'label'],
    amount: ['montant', 'amount', 'somme', 'valeur', 'net amount'],
    debit: ['debit', 'retrait', 'sortie', 'withdrawal'],
    credit: ['credit', 'versement', 'entree', 'deposit'],
    reference: ['reference', 'ref', 'numero', 'piece', 'transaction id'],
  };
  const normalized = headers.map(normalizeHeader);
  const find = (key) => {
    const hits = normalized.map((value, index) => patterns[key].some((pattern) => value === pattern || value.startsWith(`${pattern} `)) ? index : -1).filter((index) => index >= 0);
    return hits.length === 1 ? String(hits[0]) : '';
  };
  return { date: find('date'), description: find('description'), amount: find('amount'), debit: find('debit'), credit: find('credit'), reference: find('reference') };
}

function parseAmount(value) {
  let raw = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(/[FCFA€$]/gi, '');
  if (!raw) return null;
  const negativeParentheses = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[()]/g, '');
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    raw = raw.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (comma >= 0) {
    const digitsAfter = raw.length - comma - 1;
    raw = digitsAfter > 0 && digitsAfter <= 2 ? raw.replace(',', '.') : raw.replace(/,/g, '');
  } else if ((raw.match(/\./g) || []).length > 1) {
    const parts = raw.split('.');
    const tail = parts.pop();
    raw = `${parts.join('')}.${tail}`;
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const amount = Number(raw) * (negativeParentheses ? -1 : 1);
  return Number.isFinite(amount) ? amount : null;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return validDate(match[1], match[2], match[3]);
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return validDate(match[3], match[2], match[1]);
  return null;
}
function validDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
}

export function validateMappedRows(document, mapping) {
  const signed = mapping.amount !== '';
  const split = mapping.debit !== '' && mapping.credit !== '';
  if (!mapping.date || !mapping.description || signed === split) {
    return { lines: [], issues: ['Choisissez une colonne date, une description et soit un montant signé, soit les deux colonnes débit et crédit.'] };
  }
  const issues = [];
  const lines = [];
  document.rows.forEach((row, index) => {
    const lineNumber = index + 2;
    const value = (key) => row[Number(mapping[key])] ?? '';
    const date = parseDate(value('date'));
    const description = value('description').trim();
    let amount;
    if (signed) amount = parseAmount(value('amount'));
    else {
      const debitRaw = value('debit').trim();
      const creditRaw = value('credit').trim();
      const debit = debitRaw ? parseAmount(debitRaw) : 0;
      const credit = creditRaw ? parseAmount(creditRaw) : 0;
      amount = debit === null || credit === null || (debitRaw && creditRaw && debit !== 0 && credit !== 0)
        ? null : Math.abs(credit) - Math.abs(debit);
    }
    const errors = [];
    if (!date) errors.push('date invalide');
    if (!description) errors.push('description absente');
    if (amount === null || !Number.isFinite(amount)) errors.push('montant invalide');
    if (errors.length) issues.push(`Ligne ${lineNumber} : ${errors.join(', ')}.`);
    else lines.push({
      lineNumber,
      date,
      description,
      reference: String(value('reference') || '').trim(),
      amount: Math.round(amount * 100) / 100,
    });
  });
  return { lines, issues };
}
