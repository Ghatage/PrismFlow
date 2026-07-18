import {readFile, writeFile} from 'node:fs/promises';

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if (character === '\n' && !quoted) {
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r' || quoted) {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const inputPath = process.argv[2] || 'fal-model-pricing.csv';
const outputPath = process.argv[3] || 'fal-model-pricing.json';
const rows = parseCsv(await readFile(inputPath, 'utf8'));
const recordsByEndpoint = new Map();
for (const row of rows.slice(1)) {
  const endpointId = row[0];
  if (!endpointId) continue;
  const record = recordsByEndpoint.get(endpointId) || {
    id: endpointId,
    endpointId,
    model: JSON.parse(row[11]),
    prices: [],
    syncedAt: row[13],
  };
  if (row[12]) record.prices.push(JSON.parse(row[12]));
  recordsByEndpoint.set(endpointId, record);
}

const records = [...recordsByEndpoint.values()];
const priceCount = records.reduce((count, record) => count + record.prices.length, 0);
await writeFile(outputPath, `${JSON.stringify({records, modelCount: records.length, priceCount, syncedAt: records[0]?.syncedAt || null}, null, 2)}\n`, 'utf8');
console.log(`Rebuilt ${records.length} model records and ${priceCount} prices in ${outputPath}`);
