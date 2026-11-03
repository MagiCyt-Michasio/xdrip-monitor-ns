'use strict';
require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3050);
const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'nightscout';
const MANUAL_TAG = 'xdrip-monitor-ns:manual';

if (!URI) {
  console.error('Brak MONGODB_URI w .env');
  process.exit(1);
}
app.use(cors());
app.use(express.json({ limit: '32kb' }));

let client;
let db;

function millis(doc) {
  const ts = Number(doc.timestamp);
  if (Number.isFinite(ts) && ts > 0) return ts;
  const parsed = Date.parse(doc.created_at || '');
  return Number.isFinite(parsed) ? parsed : null;
}
function num(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Odrzucamy tylko rozpoznaną parę importu LibreView i bolusa odzyskanego.
// Żadne dokumenty w MongoDB nie są modyfikowane.
function normalizeTreatments(docs) {
  const rows = docs.map(doc => ({
    id: String(doc._id),
    timestamp: millis(doc),
    insulin: num(doc.insulin ?? doc.insulinUnits),
    carbs: num(doc.carbs ?? doc.carbs_g),
    eventType: doc.eventType || '',
    notes: doc.notes || ''
  })).filter(t => t.timestamp !== null && (t.insulin > 0 || t.carbs > 0));

  const skipped = new Set();
  const result = [];
  for (const row of rows) {
    if (skipped.has(row.id)) continue;
    const isLibre = row.notes.includes('LibreView CSV import');
    const isRecovered = row.eventType === 'Bolus (Odzyskany)';
    if (isLibre && row.insulin > 0) {
      const duplicate = rows.find(other =>
        other.id !== row.id && !skipped.has(other.id) &&
        other.eventType === 'Bolus (Odzyskany)' &&
        other.timestamp === row.timestamp &&
        other.insulin === row.insulin && other.carbs === row.carbs
      );
      if (duplicate) skipped.add(duplicate.id);
    } else if (isRecovered && row.insulin > 0) {
      const duplicate = rows.find(other =>
        other.id !== row.id && !skipped.has(other.id) &&
        other.notes.includes('LibreView CSV import') &&
        other.timestamp === row.timestamp &&
        other.insulin === row.insulin && other.carbs === row.carbs
      );
      if (duplicate) continue;
    }
    result.push(row);
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}
function requireDb(res) {
  if (db) return true;
  res.status(503).json({ error: 'Połączenie z bazą Nightscout nie jest gotowe.' });
  return false;
}

app.get('/health', (req, res) => res.json({
  ok: Boolean(db), service: 'xdrip-monitor-ns', database: DB_NAME
}));
app.get('/dane', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/dane', express.static(path.join(__dirname, 'public')));

app.get('/dane/api/data', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const latest = await db.collection('entries').find({
      type: 'sgv', date: { $type: 'number' }, sgv: { $type: 'number' }
    }).sort({ date: -1 }).limit(1).next();
    if (!latest) return res.json({ entries: [], treatments: [], latest: {} });

    const parsedHours = Number.parseInt(req.query.hours, 10);
    const hours = Number.isFinite(parsedHours) ? Math.min(Math.max(parsedHours, 1), 8760) : 72;
    const cutoff = latest.date - hours * 3600000;
    const [entries, raw] = await Promise.all([
      db.collection('entries').find({
        type: 'sgv', date: { $gte: cutoff, $lte: latest.date }, sgv: { $type: 'number' }
      }).sort({ date: 1 }).toArray(),
      db.collection('treatments').find({
        $or: [
          { timestamp: { $gte: cutoff } },
          { created_at: { $gte: new Date(cutoff).toISOString() } }
        ]
      }).toArray()
    ]);
    const treatments = normalizeTreatments(raw)
      .filter(t => t.timestamp >= cutoff && t.timestamp <= latest.date)
      .map(({ id, timestamp, insulin, carbs }) => ({ id, timestamp, insulin, carbs }));
    res.json({ entries, treatments, latest });
  } catch (err) {
    console.error('GET data:', err);
    res.status(500).json({ error: 'Nie udało się pobrać danych Nightscout.' });
  }
});

app.get('/dane/api/treemap', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const cutoff = Date.now() - 90 * 86400000;
    const raw = await db.collection('treatments').find({
      insulin: { $gt: 0 },
      $or: [
        { timestamp: { $gte: cutoff } },
        { created_at: { $gte: new Date(cutoff).toISOString() } }
      ]
    }).toArray();
    const treatments = normalizeTreatments(raw)
      .filter(t => t.timestamp >= cutoff && t.insulin > 0)
      .map(t => ({ timestamp: t.timestamp, insulin: t.insulin }));
    res.json({ treatments });
  } catch (err) {
    console.error('GET treemap:', err);
    res.status(500).json({ error: 'Nie udało się pobrać danych TreeMap.' });
  }
});

app.post('/dane/api/treatments', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const insulin = num(req.body.insulin);
    const carbs = num(req.body.carbs);
    const timestamp = Number(req.body.timestamp || Date.now());
    if (insulin < 0 || carbs < 0 || (!insulin && !carbs))
      return res.status(400).json({ error: 'Podaj prawidłową insulinę lub węglowodany.' });
    if (!Number.isFinite(timestamp) || timestamp <= 0)
      return res.status(400).json({ error: 'Nieprawidłowy czas wpisu.' });

    const doc = {
      created_at: new Date(timestamp).toISOString(),
      eventType: insulin && carbs ? 'Meal Bolus' : insulin ? 'Correction Bolus' : 'Carb Correction',
      notes: MANUAL_TAG,
      enteredBy: 'xdrip-monitor-ns',
      utcOffset: -new Date(timestamp).getTimezoneOffset()
    };
    if (insulin) { doc.insulin = insulin; doc.insulinType = 'fast'; }
    if (carbs) doc.carbs = carbs;
    const inserted = await db.collection('treatments').insertOne(doc);
    res.json({ success: true, doc: {
      id: String(inserted.insertedId), timestamp, insulin, carbs
    }});
  } catch (err) {
    console.error('POST treatment:', err);
    res.status(500).json({ error: 'Nie udało się zapisać wpisu w Nightscout.' });
  }
});

app.delete('/dane/api/treatments/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (!ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: 'Nieprawidłowy identyfikator wpisu.' });
    const deleted = await db.collection('treatments').deleteOne({
      _id: new ObjectId(req.params.id), notes: MANUAL_TAG
    });
    if (!deleted.deletedCount)
      return res.status(404).json({ error: 'Można usuwać tylko ręczne wpisy tego monitora.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE treatment:', err);
    res.status(500).json({ error: 'Nie udało się usunąć wpisu.' });
  }
});

async function start() {
  client = new MongoClient(URI, { maxPoolSize: 15 });
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
  app.listen(PORT, '0.0.0.0', () => {
    console.log('xDrip Monitor NS działa na porcie ' + PORT + ', baza: ' + DB_NAME);
  });
}
async function stop() {
  try { if (client) await client.close(); } finally { process.exit(0); }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start().catch(err => {
  console.error('Błąd uruchamiania:', err);
  process.exit(1);
});
